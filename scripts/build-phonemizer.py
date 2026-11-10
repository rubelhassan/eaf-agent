#!/usr/bin/env python3
"""Build the pinned browser phonemizer into an explicitly selected directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def digest(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked_archive(spec, cache, name):
    file = cache / name
    if not file.exists():
        subprocess.run(['curl', '-fLsS', '--max-time', '120', spec['url'], '-o', str(file)], check=True)
    if digest(file) != spec['sha256']:
        raise ValueError(f'Checksum mismatch: {file}')
    return file


def extract(archive, destination, prefix=''):
    with tarfile.open(archive) as source:
        members = [item for item in source.getmembers() if item.name.startswith(prefix)]
        for item in members:
            file = destination / item.name
            link = file.parent / item.linkname if item.issym() else destination / item.linkname
            if not file.resolve().is_relative_to(destination.resolve()) or (
                    (item.issym() or item.islnk()) and not link.resolve().is_relative_to(destination.resolve())):
                raise ValueError(f'Unsafe source archive entry: {item.name}')
        source.extractall(destination, members=members)


def version(command):
    return subprocess.check_output([command, '--version'], text=True).splitlines()[0]


def memory_limits(file):
    data = file.read_bytes()
    position = 8

    def integer():
        nonlocal position
        result = shift = 0
        while True:
            byte = data[position]
            position += 1
            result |= (byte & 127) << shift
            if byte < 128:
                return result
            shift += 7

    while position < len(data):
        section = data[position]
        position += 1
        size = integer()
        end = position + size
        if section == 5:
            if integer() != 1:
                raise ValueError('Expected exactly one WASM memory')
            flags = integer()
            initial = integer()
            maximum = integer() if flags & 1 else None
            return {'initialBytes': initial * 65536, 'maximumBytes': maximum * 65536 if maximum else None}
        position = end
    raise ValueError('WASM memory declaration not found')


def build(options):
    manifest = json.loads((ROOT / 'test/acblock/models/engines.json').read_text())
    tts = manifest['engines']['tts']
    spec = tts['phonemizer']
    out = Path(options.out).resolve()
    if out.exists():
        raise ValueError('Output must be a new isolated directory')
    emcc = shutil.which('emcc')
    if not emcc:
        raise ValueError('Activate the pinned Emscripten SDK before building')
    emscripten = Path(os.environ.get('EMSCRIPTEN') or Path(emcc).resolve().parent)
    versions = {'emcc': version('emcc'), 'cmake': version('cmake'), 'make': version('make'),
                'python': sys.version.splitlines()[0], 'platform': platform.platform()}
    if manifest['emsdk'] not in versions['emcc']:
        raise ValueError('Emscripten does not match engines.json')
    if manifest['python']['cmake'] not in versions['cmake']:
        raise ValueError('CMake does not match engines.json')
    cache = ROOT / 'tools/downloads/phonemizer'
    cache.mkdir(parents=True, exist_ok=True)
    source = checked_archive(spec['source'], cache, 'piper.tar.gz')
    espeak = checked_archive(spec['espeak'], cache, 'espeak.zip')
    model = checked_archive(tts['downloads'][0], ROOT / 'tools/downloads', Path(tts['downloads'][0]['url']).name)
    work_root = ROOT / 'tools/work/phonemizer'
    work_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f'{options.memory}m-', dir=work_root))
    extract(source, work)
    src = work / ('piper-phonemize-' + spec['source']['commit'])
    dependency = 'espeak-ng-' + spec['espeak']['commit'] + '.zip'
    shutil.copyfile(espeak, src / dependency)
    extract(model, work, spec['dictionarySource'] + '/')
    dictionaries = work / spec['dictionarySource']
    shutil.copytree(dictionaries, src / 'wasm/browser/assets/espeak-ng-data')
    dictionary_hashes = {str(file.relative_to(dictionaries)): digest(file) for file in sorted(dictionaries.rglob('*')) if file.is_file()}
    flags_file = src / 'wasm/browser/CMakeLists.txt'
    original = flags_file.read_text()
    if original.count('INITIAL_MEMORY=256MB') != 1:
        raise ValueError('Pinned source memory setting changed')
    flags_file.write_text(original.replace('INITIAL_MEMORY=256MB', f'INITIAL_MEMORY={options.memory}MB'))
    build_dir = work / 'build'
    install = work / 'install'
    configure = ['cmake', '-S', str(src), '-B', str(build_dir),
                 '-DCMAKE_TOOLCHAIN_FILE=' + str(emscripten / 'cmake/Modules/Platform/Emscripten.cmake'),
                 '-DCMAKE_INSTALL_PREFIX=' + str(install), '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
                 '-DBUILD_PIPER_PHONEMIZE_PYTHON=OFF', '-DBUILD_PIPER_PHONEMIZE_CORE_TESTS=OFF',
                 '-DBUILD_PIPER_PHONEMIZE_CORE_EXE=OFF', '-DPIPER_PHONEMIZE_ENABLE_WASM=ON',
                 '-DPIPER_PHONEMIZE_ENABLE_WASM_BROWSER=ON', '-DFETCHCONTENT_FULLY_DISCONNECTED=OFF']
    env = {**os.environ, 'PIPER_PHONEMIZE_IS_USING_BUILD_WASM_SH': '1'}
    subprocess.run(configure, env=env, check=True)
    subprocess.run(['cmake', '--build', str(build_dir), '--parallel', str(options.jobs)], env=env, check=True)
    subprocess.run(['cmake', '--install', str(build_dir)], env=env, check=True)
    built = install / 'bin/wasm/browser'
    limits = memory_limits(built / 'piper-phonemize-wasm-main.wasm')
    if limits != {'initialBytes': options.memory * 1048576, 'maximumBytes': spec['maximumMemoryMiB'] * 1048576}:
        raise ValueError(f'Unexpected WASM memory: {limits}')
    shutil.copytree(built, out)
    info = {'source': spec['source'], 'espeak': spec['espeak'], 'dictionaryArchive': tts['downloads'][0],
            'dictionaryFiles': dictionary_hashes, 'versions': versions, 'memory': limits, 'stackBytes': spec['stackBytes'],
            'configure': configure, 'buildDirectory': str(build_dir),
            'artifacts': {file.name: digest(file) for file in sorted(out.iterdir()) if file.is_file()}}
    (out / 'BUILD_INFO.json').write_text(json.dumps(info, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'memory': limits, 'versions': versions}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--memory', type=int, choices=[16, 256], required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--jobs', type=int, default=4)
    build(parser.parse_args())
