/**
 * Regenerates the guides' screenshots (docs/img/*.png) and the numbered marker
 * positions (docs/guide-markers.json) from the running test app.
 *
 *   python3 -m http.server 8765 -d test/acblock      # in another terminal
 *   npm i --no-save playwright-core
 *   CHROME_PATH=/path/to/chrome node test/acblock/docs/capture-guide.js [student|teacher]
 *
 * With no argument both guides are captured; with one, only that guide's pictures
 * and markers change. The agent is stubbed (testing config), so no model is called.
 * Marker numbers must match the numbered lists in docs/student-guide.html and
 * docs/teacher-guide.html.
 */

const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright-core');

const BASE = process.env.GUIDE_BASE_URL || 'http://localhost:8765/';
const OUT = __dirname;
const MARKERS = path.join(OUT, 'guide-markers.json');
const ONLY = process.argv[2];
const markers = fs.existsSync(MARKERS) ? JSON.parse(fs.readFileSync(MARKERS, 'utf8')) : {};

async function main() {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH});
  const context = await browser.newContext({viewport: {width: 1400, height: 900}, deviceScaleFactor: 2});
  const page = await context.newPage();
  await page.route('**/config.local.js', (r) => r.fulfill({contentType: 'text/javascript', body: 'export default { testing: true };'}));
  page.on('dialog', (d) => d.accept());
  fs.mkdirSync(path.join(OUT, 'img'), {recursive: true});

  /** Bounding box of whatever `find` returns (a CSS selector, or a function run in the page). */
  const rect = (find) => page.evaluate((f) => {
    const el = f.startsWith('js:') ? (0, eval)(f.slice(3)) : document.querySelector(f);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  }, find);

  /** Screenshot of `clip` (a box or a finder) with numbered boxes around each finder in `marks`. */
  async function shot(name, clip, marks, pad = 8) {
    const c = typeof clip === 'string' ? await rect(clip) : clip;
    const box = {x: Math.max(0, c.x - pad), y: Math.max(0, c.y - pad), width: c.w + 2 * pad, height: c.h + 2 * pad};
    await page.screenshot({path: path.join(OUT, 'img', `${name}.png`), clip: box});
    const list = [];
    for (let i = 0; i < marks.length; i++) {
      const r = await rect(marks[i]);
      if (!r) throw new Error(`${name}: marker ${i + 1} not found (${marks[i]})`);
      const pct = (v, total) => Math.round((v / total) * 1000) / 10;
      list.push({n: i + 1, box: {
        x: pct(r.x - 3 - box.x, box.width), y: pct(r.y - 3 - box.y, box.height),
        w: pct(r.w + 6, box.width), h: pct(r.h + 6, box.height)}});
    }
    markers[name] = {markers: list};
  }

  const open = async (url, program) => {
    await page.goto(BASE + url);
    await page.waitForTimeout(1500);
    if (program) {
      await page.selectOption('#programSelect', program);
      await page.waitForTimeout(900);
    }
  };
  const settings = async (show) => {
    const hidden = await page.evaluate(() => document.getElementById('settingsPanel').hidden);
    if (hidden === show) await page.click('#settingsButton');
    await page.waitForTimeout(200);
  };
  const toolboxItem = (name) => `js:workspace.getToolbox().getToolboxItems().find((i) => i.getName?.() === ${JSON.stringify(name)}).getDiv()`;
  const whole = {x: 0, y: 0, w: 1400, h: 900};

  if (ONLY !== 'teacher') await student({page, open, settings, shot});
  if (ONLY === 'student') return finish(browser);

  // 1. Teacher mode basics.
  await open('index.html?teacher=1', 'DemoSkipCountPractice');
  await settings(true);
  await shot('teacher-mode', whole, ['#roleBadge', '#settingsButton', '#teacherModeToggle', toolboxItem('Hint'), '#teacherGuideBtn'], 0);

  // 2. The Hint category with both question blocks.
  await settings(false);
  await page.evaluate(() => {
    const tb = workspace.getToolbox();
    tb.setSelectedItem(tb.getToolboxItems().find((i) => i.getName?.() === 'Hint'));
  });
  await page.waitForTimeout(400);
  const flyoutBlock = (i) => `js:workspace.getFlyout().getWorkspace().getTopBlocks(true)[${i}].getSvgRoot()`;
  await shot('hint-category', {x: 70, y: 80, w: 560, h: 300}, [toolboxItem('Hint'), flyoutBlock(0), flyoutBlock(1)], 0);
  await page.evaluate(() => workspace.getToolbox().clearSelection());

  // 3 to 4. The Edit question form, opened from a question's popover.
  const openEdit = async (id) => {
    await page.evaluate((qid) => blockTypes.activate(workspace.getBlockById(qid), {workspace, speech: {update() {}}}), id);
    await page.waitForTimeout(300);
    await page.getByRole('button', {name: 'Edit question'}).click();
    await page.waitForTimeout(400);
  };
  await openEdit('q_grow');
  const fieldset = (legend) => `js:[...document.querySelectorAll('.eaf-qd fieldset')].find((f) => f.querySelector('legend')?.textContent === ${JSON.stringify(legend)})`;
  await shot('edit-question-top', '.eaf-qd', [
    fieldset('What goes in the question block'),
    fieldset('What the learner hears'),
    '.eaf-qd-pickrow select',
    '.eaf-bs-button',
    'js:[...document.querySelectorAll(".eaf-qd-pickrow button")].find((b) => b.textContent === "Add")',
    '.eaf-qd-chosen',
  ], 0);
  const scrollTo = (legend, block) => page.evaluate(({legend, block}) => {
    const f = [...document.querySelectorAll('.eaf-qd fieldset')].find((x) => x.querySelector('legend')?.textContent === legend);
    f.scrollIntoView({block});
  }, {legend, block});
  await scrollTo('Reference answer', 'start');
  await page.waitForTimeout(200);
  await shot('edit-question-reference', '.eaf-qd', [
    'js:[...document.querySelectorAll(".eaf-qd fieldset")].find((f) => f.querySelector("legend")?.textContent === "Reference answer").querySelector("svg")',
    'js:[...document.querySelectorAll(".eaf-qd button")].find((b) => b.textContent === "Put in slot to edit")',
    'js:[...document.querySelectorAll(".eaf-qd button")].find((b) => b.textContent === "Remove" && b.closest("fieldset")?.querySelector("legend")?.textContent === "Reference answer")',
  ], 0);
  await scrollTo('Choices', 'end');
  await page.waitForTimeout(200);
  await shot('edit-question-hints', '.eaf-qd', [
    fieldset('Written hints'),
    'js:[...document.querySelectorAll(".eaf-qd fieldset")].find((f) => f.querySelector("legend")?.textContent === "AI hints").querySelector("select")',
    fieldset('Choices'),
    'js:[...document.querySelectorAll(".eaf-qd-footer button")].find((b) => b.textContent === "Save")',
  ], 0);
  await page.getByRole('button', {name: 'Cancel'}).click();

  // 5. A reference answer in the slot (teacher mode).
  await page.evaluate(() => {
    for (const q of workspace.getBlocksByType('question')) {
      const ref = q.getQuestionConfig().reference;
      const block = Blockly.serialization.blocks.append(ref, workspace);
      q.getInput('ANSWER').connection.connect(block.outputConnection || block.previousConnection);
      q.setQuestionConfig({...q.getQuestionConfig(), reference: null});
    }
  });
  await page.waitForTimeout(500);
  const blockSvg = (id) => `js:workspace.getBlockById(${JSON.stringify(id)}).getSvgRoot()`;
  await shot('reference-slot', blockSvg('print_1'), [blockSvg('q_grow'), blockSvg('q_show')], 40);

  // 6. Task tools in Settings.
  await settings(true);
  await page.evaluate(() => document.getElementById('teacherToolsRow').scrollIntoView({block: 'end'}));
  await shot('task-tools', '#settingsPanel', ['#activitySelect', '#editModeSelect', '#wholePlanToggle', '#exportTaskBtn', '#importTaskBtn', '#makeScaffoldBtn', '#taskTestsBtn'], 4);

  // 7. Task tests dialog.
  await page.click('#taskTestsBtn');
  await page.waitForTimeout(300);
  await shot('task-tests', '.eaf-qd', [
    '.eaf-qd-test textarea',
    'js:document.querySelectorAll(".eaf-qd-test textarea")[1]',
    'js:[...document.querySelectorAll(".eaf-qd button")].find((b) => b.textContent === "Add test")',
    'js:[...document.querySelectorAll(".eaf-qd-footer button")].find((b) => b.textContent === "Run tests")',
  ], 0);

  // 8. Assessment in the output panel (the slots hold the reference answers, so everything fits).
  await page.getByRole('button', {name: 'Run tests'}).click();
  await page.waitForTimeout(800);
  const line = (start) => `js:[...document.querySelectorAll("#outputPanel .output-line")].find((l) => l.textContent.includes(${JSON.stringify(start)}))`;
  await shot('assessment', '.output-container', [line('Assessment'), line('Questions:'), line('Tests:')], 4);

  // 9 to 10. Make scaffold on Program 18.
  await open('index.html?teacher=1', 'Program18');
  await settings(true);
  await page.click('#makeScaffoldBtn');
  await page.waitForTimeout(300);
  await page.selectOption('.eaf-qd select >> nth=0', 'math');
  await page.selectOption('.eaf-qd select >> nth=1', 'intermediate');
  await shot('scaffold-dialog', '.eaf-qd', [
    '.eaf-qd select',
    'js:document.querySelectorAll(".eaf-qd select")[1]',
    '.eaf-qd [role=status]',
    'js:[...document.querySelectorAll(".eaf-qd-footer button")].find((b) => b.textContent === "Make scaffold")',
  ], 0);
  await page.getByRole('button', {name: 'Make scaffold', exact: true}).click();
  await page.waitForTimeout(1200);
  await shot('scaffold-result', blockSvg('print_1'), [`js:workspace.getBlocksByType('question')[0].getSvgRoot()`], 40);

  await finish(browser);
}

async function finish(browser) {
  fs.writeFileSync(MARKERS, JSON.stringify(markers, null, 2) + '\n');
  await browser.close();
  console.log(`Markers for ${Object.keys(markers).length} screenshots.`);
}

/** The student guide's pictures, in learner mode. */
async function student({page, open, settings, shot}) {
  const whole = {x: 0, y: 0, w: 1400, h: 900};

  // The panel picture shows text mode (the text box); the voice section has its own picture.
  await page.addInitScript(() => localStorage.setItem('eaf.assistantMode', 'text'));
  // 1. The editor.
  await open('index.html', 'Program18');
  await shot('student-editor', whole, ['#navToggle', '.eaf-mode-badge', '#runButton', '#settingsButton', '.assistant-open'], 0);

  // 5. The assistant panel with a plan (a stubbed plan view; nothing is applied).
  await page.evaluate(() => {
    const ui = window.eafAssistant;
    ui.open();
    ui.showPlan({proposalId: 'guide', kind: 'edit', ended: false, canAll: false, steps: [
      {words: 'Add a repeat block to stack A.', status: 'applied'},
      {words: 'Set the number in the repeat block to 5.', status: 'next'},
      {words: 'Move the print block into the repeat.', status: 'waiting'},
    ]});
    ui.displayReply({say: 'Step 2 of 3. Set the number in the repeat block to 5. Should I do it? Say yes or no.', expectsAnswer: true,
      actions: [{name: 'yes', label: 'Yes'}, {name: 'no', label: 'No'}, {name: 'cancel', label: 'Cancel'}, {name: 'repeat', label: 'Hear again'}]});
  });
  await page.waitForTimeout(500);
  await shot('student-panel', '.assistant-panel', ['.assistant-transcript', '.assistant-plan', '.assistant-answers', '.assistant-voice', '.assistant-input', '.assistant-send'], 0);
  // 7. Voice mode: the toggle, the voice area with two dictated pieces and one being heard, Send.
  await page.click('.assistant-voice');
  await page.evaluate(() => {
    const panel = window.eafAssistant.panel;
    panel.setMicrophoneState('listening');
    panel.draft.setSpoken('make it say hello', '');
    panel.draft.setSpoken('make it say hello five times', 'make it say hello');
    panel.draft.setPartial('and then');
  });
  await page.waitForTimeout(300);
  await shot('student-voice', '.assistant-draft', ['.assistant-voice', '.assistant-voice-area', '.assistant-send'], 4);
  // Listening paused: the resume button above the mode button.
  await page.evaluate(() => window.eafAssistant.panel.setMicrophoneState('paused'));
  await page.waitForTimeout(300);
  await shot('student-voice-paused', '.assistant-draft', ['.assistant-resume', '.assistant-mic-state'], 4);
  await page.evaluate(() => window.eafAssistant.panel.setMicrophoneState('listening'));
  await page.evaluate(() => {
    window.eafAssistant.panel.draft.setPartial('');
    window.eafAssistant.panel.draft.set('');
  });
  await page.click('.assistant-voice');
  await page.evaluate(() => window.eafAssistant.showPlan(null));
  await page.keyboard.press('Escape');

  // 9. A question's help (Demo 1, learner mode).
  await open('index.html', 'DemoQuestions');
  await page.evaluate(() => blockTypes.activate(workspace.getBlockById('q_heavy'), {workspace, speech: {update() {}}}));
  await page.waitForTimeout(400);
  const buttonRow = (name) => `js:[...document.querySelectorAll('.eaf-qp button')].find((b) => b.textContent === ${JSON.stringify(name)}).closest('[data-row]')`;
  const qp = await page.evaluate(() => { const p = document.querySelector('.eaf-qp').getBoundingClientRect(); const b = workspace.getBlockById('q_heavy').getSvgRoot().getBoundingClientRect();
    const x = Math.min(p.x, b.x), y = Math.min(p.y, b.y); return {x, y, w: Math.max(p.right, b.right) - x, h: Math.max(p.bottom, b.bottom) - y}; });
  await shot('student-question', qp, ['.eaf-qp [data-row="0"]', buttonRow('Next hint'), buttonRow('Hear all')], 12);
  await page.keyboard.press('Escape');

  // 10. Settings.
  await settings(true);
  await shot('student-settings', '#settingsPanel', ['#learnerLevelSelect', '#magnifierSelect', '#pauseEditingToggle', '#learnerEditModeSelect', '#soundSettingsBtn', '#saveWorkBtn', '#studentGuideBtn'], 4);
  await settings(false);

  // 11. The magnifier on the cursor's block.
  await open('index.html', 'Program18');
  await page.evaluate(() => {
    const block = workspace.getTopBlocks(true)[0];
    workspace.getCursor().setCurNode(Blockly.ASTNode.createBlockNode(block));
  });
  await page.focus('.blocklySvg').catch(() => {});
  await page.keyboard.press('Control+Shift+Equal');
  await page.waitForTimeout(500);
  const lensBox = await page.evaluate(() => {
    const l = document.querySelector('.eaf-magnifier').getBoundingClientRect();
    const b = workspace.getTopBlocks(true)[0].getSvgRoot().getBoundingClientRect();
    const x = Math.min(l.x, b.x), y = Math.min(l.y, b.y);
    return {x, y, w: Math.max(l.right, b.right) - x, h: Math.max(l.bottom, b.bottom) - y};
  });
  await shot('student-magnifier', lensBox, ['js:workspace.getTopBlocks(true)[0].getSvgRoot()', '.eaf-magnifier'], 16);
  await page.keyboard.press('Escape');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
