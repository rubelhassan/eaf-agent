// Deterministic text only. No audio, microphone or model calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {parse} = require('@babel/parser');
const ROOT = path.resolve(__dirname, '..');

function files(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.js') ? [file] : [];
  });
}

function appText() {
  const rows = [];
  const sources = [...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, 'test/acblock/js'))]
      .map(file => ({file, code: fs.readFileSync(file, 'utf8'), offset: 0}));
  const index = path.join(ROOT, 'test/acblock/index.html');
  const html = fs.readFileSync(index, 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!match[2].trim() || /type=["'](?:application\/json|importmap)["']/i.test(match[1])) continue;
    sources.push({file: index, code: match[2], offset: html.slice(0, match.index).split('\n').length - 1});
  }
  for (const {file, code, offset} of sources) {
    const ast = parse(code, {sourceType: 'unambiguous'});
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      const text = node.type === 'StringLiteral' ? node.value : node.type === 'TemplateLiteral' ?
        node.quasis.map(part => part.value.cooked ?? part.value.raw).join('Neon') : null;
      // A superset of spoken constants also covers labels and templates read on focus.
      if (text && /\p{L}/u.test(text)) rows.push({category: 'app-fixed', text,
        source: path.relative(ROOT, file), line: node.loc.start.line + offset, template: node.type === 'TemplateLiteral'});
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    }
    visit(ast.program);
  }
  return rows;
}

function corpus() {
  const rows = [];
  const names = ['Sam', 'Kristin', 'Neon', 'Aisha', 'Noah', 'Maya', 'Oliver', 'Charlotte', 'Amir', 'Sofia',
    'Ethan', 'Zoe', 'Mateo', 'Grace', 'Avery', 'Chloe', 'Leo', 'Nora', 'Isaac', 'Aria', 'Theo', 'Layla', 'Owen', 'Elena', 'Ezra'];
  const actions = ['print the greeting', 'repeat the instructions', 'move the block', 'change the number', 'find the variable',
    'read this stack', 'add a condition', 'explain the question', 'undo this step', 'name the stack'];
  const punctuation = ['Hello, world!', 'Is it ready?', 'Yes; please continue.', 'Wait... what happened?',
    'One: two; three.', 'The helper (Neon) is ready.', 'Stop! Then try again.', 'A/B and C+D equal what?',
    'She said, "Hello!"', "Don't change Sam's work."];
  const unicode = ['café', 'naïve', 'résumé', 'jalapeño', '你好', 'こんにちは', 'مرحبا', 'שלום', 'नमस्ते', 'Привет'];
  const symbols = ['🙂', '👩🏽‍💻', '🚀', '❤️', '🏳️‍🌈', '≤ ≥ ≠', '∑ π √', '& < > | *', '™ © ®', '🙂你好مرحبا'];
  for (let i = 0; i < 50; i++) {
    rows.push({category: 'classroom', text: `Please ${actions[i % actions.length]} in stack ${String.fromCharCode(65 + i % 8)}, step ${i + 1}.`});
    rows.push({category: 'numbers', text: `Count ${i}, ${-i - 1}, and ${i}.75; pay $${i + 1}.05 on ${i % 12 + 1}/${i % 28 + 1}/2026 at ${i % 12 + 1}:30. Finish ${i + 1}st.`});
    rows.push({category: 'names', text: `${names[i % names.length]} and ${names[(i + 7) % names.length]} named variable R${i}D2 at UNT and NASA.`});
    rows.push({category: 'punctuation', text: `${punctuation[i % punctuation.length]} ${punctuation[(i + 3) % punctuation.length]} Number ${i}.`});
    rows.push({category: 'quotes', text: `Print "Hello ${names[i % names.length]}"; the text is 'Score: ${i} / 50'. Read Dr. Jones, Mr. Lee and St. Paul.`});
    rows.push({category: 'unicode', text: `${unicode[i % unicode.length]} ${unicode[(i + 4) % unicode.length]} ${symbols[i % symbols.length]} Sample ${i}.`});
    rows.push({category: 'long', text: (`The helper reads step ${i + 1}, checks the number ${i}.25, and asks before changing the program. `).repeat(i + 15)});
    rows.push({category: 'helper', text: `${['help', 'helper', 'helper.', 'I am your coding helper.', 'The helper can help you.'][i % 5]} ${punctuation[(i + 1) % punctuation.length]} ${i + 1}`});
  }
  rows.push(...['', ' ', '\t\n', '.', '?!', '🙂', '你好', 'مرحبا', '\u0000', '\u200d', 'help', 'helper', 'helper.',
    'I am your coding helper.', 'The helper can help you.'].map(text => ({category: 'boundary', text})));
  const fixed = appText();
  rows.push(...fixed);
  const longestFixed = Math.max(...fixed.map(row => row.text.length));
  const stressSize = Math.max(100000, longestFixed + 10000);
  rows.push({category: 'beyond-reply', text: 'The helper can help you. '.repeat(Math.ceil(stressSize / 24))});
  const unique = [...new Map(rows.map(row => [row.text, row])).values()].map((row, i) => ({id: `phone-${i + 1}`, ...row}));
  return {version: 1, voice: 'en', longestFixedCharacters: longestFixed, stressCharacters: unique.at(-1).text.length,
    cases: unique, sha256: crypto.createHash('sha256').update(JSON.stringify(unique)).digest('hex')};
}

module.exports = {corpus};
if (require.main === module) process.stdout.write(JSON.stringify(corpus(), null, 2) + '\n');
