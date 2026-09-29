/**
 * Regenerates the teacher guide's screenshots (docs/img/*.png) and the numbered
 * marker positions (docs/guide-markers.json) from the running test app.
 *
 *   python3 -m http.server 8765 -d test/acblock      # in another terminal
 *   npm i --no-save playwright-core
 *   CHROME_PATH=/path/to/chrome node test/acblock/docs/capture-guide.js
 *
 * The agent is stubbed (testing config), so no model is called. Marker numbers
 * must match the numbered lists in docs/teacher-guide.html.
 */

const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright-core');

const BASE = process.env.GUIDE_BASE_URL || 'http://localhost:8765/';
const OUT = __dirname;
const markers = {};

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
  await shot('task-tools', '#settingsPanel', ['#activitySelect', '#exportTaskBtn', '#importTaskBtn', '#makeScaffoldBtn', '#taskTestsBtn'], 4);

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

  fs.writeFileSync(path.join(OUT, 'guide-markers.json'), JSON.stringify(markers, null, 2) + '\n');
  await browser.close();
  console.log(`Captured ${Object.keys(markers).length} screenshots.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
