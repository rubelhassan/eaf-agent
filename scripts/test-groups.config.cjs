'use strict';

const groups = {
  nav: ['navigation_value_blocks', 'mode_badge', 'focus_magnifier'],
  blocks: ['question_block', 'question_solved', 'learner_work', 'authorship', 'dialog_speech'],
  agent: ['agent_plan', 'agent_client', 'agent_contracts', 'harness_context', 'split', 'speech_qa'],
  interaction: ['interaction', 'events_and_keys', 'guided', 'new_stacks'],
  voice: ['voice', 'voice_vocabulary', 'voice_modes'],
  output: ['output_manager', 'typing_echo'],
  panel: ['assistant_panel', 'step_list', 'demo_controls'],
  runner: ['program_runner'],
  eval: ['eval_scorers', 'voice_pilot', 'eval_agent_plan', 'eval_items', 'eval_arms', 'eval_voice_modes'],
  server: [],
};

const requirements = {
  eval: {requires: 'eval/runner', message: 'Skipping the eval and voice pilot tests: eval/ is not in this copy (private research data).'},
};

const nodeTests = {
  eval: ['eval/voice-pilot/barge_bench.test.mjs'],
};

function serverBuildGroups(tests) {
  return Object.keys(groups).filter((name) => groups[name].some((test) =>
    tests[test]?.some((file) => file.startsWith('server/dist/'))));
}

// Ownership also covers injected interfaces and files read at runtime, which
// webpack cannot discover. Its module graph adds the other consuming groups.
const rules = [
  [/^src\/index\.js$/, Object.keys(groups)],
  [/^src\/(navigation[^/]*|cursors\/)/, ['nav']],
  [/^src\/labels_and_comments\//, ['nav', 'blocks']],
  [/^src\/util\/(dialog_speech|shortcut_assistance|navigational_hint)\.js$/, ['blocks', 'nav']],
  [/^src\/util\/(assistant_keys|navigation_lock)\.js$/, ['interaction', 'panel']],
  [/^src\/util\//, ['nav']],
  [/^src\/blocks\//, ['blocks']],
  [/^src\/agent\//, ['agent']],
  [/^src\/interaction\//, ['interaction', 'voice', 'panel', 'eval']],
  [/^src\/voice\//, ['voice', 'panel']],
  [/^src\/voice\/draft\.js$/, ['eval']],
  [/^src\/(output\/|audio\/speech\.js$)/, ['output', 'voice', 'panel', 'blocks', 'nav']],
  [/^src\/runner\//, ['runner', 'blocks', 'eval']],
  [/^test\/acblock\/js\/assistant\//, ['panel']],
  [/^test\/acblock\/js\/voice\//, ['voice', 'eval']],
  [/^test\/acblock\/(xml\/|.*toolbox)/, ['blocks', 'eval']],
  [/^test\/support\//, ['nav', 'blocks', 'agent', 'interaction', 'voice', 'panel', 'runner', 'eval']],
  [/^eval\//, ['eval']],
  [/^server\/test\//, ['server']],
  [/^server\//, ['server', 'eval']],
];

const fullGate = /^(package(?:-lock)?\.json|(?:[^/]*webpack[^/]*|build\.sh|tsconfig[^/]*)$|scripts\/|test\/(?:\.mocharc[^/]*|helpers\/)|node_modules\/)/;
const documentation = /(?:\.(?:md|docx|png|jpe?g|svg|pdf)$|^(?:notes|secret)\/)/i;

module.exports = {groups, requirements, nodeTests, serverBuildGroups, rules, fullGate, documentation};
