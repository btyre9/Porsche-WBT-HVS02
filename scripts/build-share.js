#!/usr/bin/env node
'use strict';

/**
 * build-share.js — builds two copies of the module that coworkers can open by
 * double-clicking, with nothing to install (Windows PowerShell does the serving):
 *
 *   output/share/<CODE>-Review.zip    free navigation, every slide unlocked, no
 *                                     Next gating, review-notes drawer (Export
 *                                     all notes). For checking text and images.
 *   output/share/<CODE>-LMS-Test.zip  the real SCORM zip, run through the PALMS
 *                                     upload gates and launched inside the
 *                                     PALMS-style SCORM 1.2 harness (strict API,
 *                                     4096-char suspend_data cap, call log).
 *
 * Each zip unpacks to a folder with one "Open ... .bat" to double-click, a
 * README.txt, and _files/ (the course plus scripts/share/serve.ps1).
 *
 * Usage:  npm run share            (both)
 *         npm run share -- --review-only | --lms-only
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output');
const SHARE = path.join(OUT, 'share');
const args = process.argv.slice(2);
const doReview = !args.includes('--lms-only') && !args.includes('--review-scorm-only');
const doLms = !args.includes('--review-only') && !args.includes('--review-scorm-only');
// Opt-in: the review copy as a SCORM zip (LMS or SCORM Cloud invitation link).
const doReviewScorm = args.includes('--review-scorm') || args.includes('--review-scorm-only');

// Module code from the folder name: Porsche-WBT-HVS01 -> HVS01.
const CODE = path.basename(ROOT).replace(/^porsche-wbt-/i, '').toUpperCase();
// Same name package-scorm.js gives the zip: Porsche-WBT-HVS01 -> porsche-wbt-hvs01-scorm.zip.
const SCORM_ZIP = path.join(OUT, path.basename(ROOT).toLowerCase() + '-scorm.zip');

const PY = (() => {
  for (const c of ['python', 'python3', 'py']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (_) {}
  }
  throw new Error('Python is needed to zip and to run the PALMS preflight (tried python, python3, py).');
})();

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
}
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text.replace(/\r?\n/g, '\r\n')); }

function zipFolder(dir, zipPath) {
  rm(zipPath);
  execFileSync(PY, ['-c', [
    'import zipfile, os, sys',
    'src, out = sys.argv[1], sys.argv[2]',
    'base = os.path.dirname(src)',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:',
    '    for d, _, files in os.walk(src):',
    '        for f in files:',
    '            if f.startswith("._") or f == ".DS_Store": continue  # macOS junk (exFAT drive)',
    '            p = os.path.join(d, f)',
    '            z.write(p, os.path.relpath(p, base))',
  ].join('\n'), dir, zipPath], { stdio: 'inherit' });
}

// Executables or installers dropped into course/ would ship in every package.
function refuseJunk() {
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|msi|bat|cmd|ps1|vbs|dll|zip|7z|rar)$/i.test(e.name)) bad.push(path.relative(ROOT, p));
    }
  })(path.join(ROOT, 'course'));
  if (bad.length) {
    console.error('\nStopped: these files are inside course/ and would ship in every package:\n  ' + bad.join('\n  ') + '\nMove them out of course/ and run again.\n');
    process.exit(1);
  }
}

function launcher(port, open, title) {
  return [
    '@echo off',
    `rem Double-click to open ${title}. Keep the window that appears open while you use it.`,
    'setlocal',
    'set "WBT_DIR=%~dp0_files"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($env:WBT_DIR + \'\\serve.ps1\'))) ' +
      `-Root 'site' -Port ${port} -Open '${open}' -Name '${title}'"`,
    'if errorlevel 1 pause',
    '',
  ].join('\n');
}

function stageCommon(dir) {
  rm(dir);
  fs.mkdirSync(path.join(dir, '_files'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'share', 'serve.ps1'), path.join(dir, '_files', 'serve.ps1'));
}

// Review-only extras, written into a review site's data/ folder:
//  - review-config.json: the review round (build date and time, so each new
//    review copy starts with an empty notes list) and the reviewers' upload link from the workspace's
//    review-watch.json (dashboard Review panel ⚙); after Export, reviewers get a
//    button that opens the shared notes folder.
//  - reviewer-briefs.json: notes the author wrote for reviewers (dashboard Slide
//    tab > Note for Reviewers), shown when a reviewer reaches the slide.
// Returns the files written so a caller can remove them again.
function addReviewExtras(siteDir) {
  const written = [];
  let watchCfg = null;
  for (let d = ROOT, i = 0; i < 4 && !watchCfg; d = path.dirname(d), i++) {
    const f = path.join(d, 'review-watch.json');
    if (fs.existsSync(f)) { try { watchCfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} }
  }
  // Round label: when this review copy was built. The player keeps each round's
  // notes apart, so every new review copy starts with an empty notes list.
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const round = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const cfg = { round };
  if (watchCfg && watchCfg.link) cfg.uploadLink = watchCfg.link;
  const f = path.join(siteDir, 'data', 'review-config.json');
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  written.push(f);
  console.log(`   review round ${round}${cfg.uploadLink ? ', with the reviewers\' upload link' : ''}`);
  const briefs = path.join(ROOT, 'review', 'reviewer-briefs.json');
  if (fs.existsSync(briefs)) {
    const f = path.join(siteDir, 'data', 'reviewer-briefs.json');
    fs.copyFileSync(briefs, f);
    written.push(f);
    console.log(`   included ${Object.keys(JSON.parse(fs.readFileSync(briefs, 'utf8'))).length} note(s) for reviewers`);
  }
  return written;
}

const built = [];
refuseJunk();
fs.mkdirSync(SHARE, { recursive: true });

// ── Review copy ─────────────────────────────────────────────────────────────
if (doReview) {
  console.log(`\n== ${CODE} Review: building the review player`);
  run('node', ['scripts/sync-output.js', '--review']);
  const dir = path.join(SHARE, `${CODE}-Review`);
  stageCommon(dir);
  copyDir(path.join(OUT, 'course'), path.join(dir, '_files', 'site'));
  addReviewExtras(path.join(dir, '_files', 'site'));
  write(path.join(dir, `Open ${CODE} Review.bat`), launcher(8791, '/player/index.html?review=1', `${CODE} Review`));
  write(path.join(dir, 'README.txt'), `${CODE} — review copy
${'='.repeat(CODE.length + 16)}

TO OPEN
  1. Unzip this folder anywhere (Desktop is fine). Don't open it from inside the zip.
  2. Double-click "Open ${CODE} Review.bat".
     If Windows asks whether to run it, choose "Run" (or "More info" > "Run anyway").
  3. A small black window opens and the course opens in your browser.
     Keep the black window open while you review; close it when you're done.

MOVING AROUND
  Every slide is unlocked. Use Next/Back at any time, or open the menu
  (top left) and jump to any slide. Nothing has to be completed first.

NOTES FROM THE AUTHOR
  Some slides have a yellow "Note from the course author" box: something to
  know about the slide, or a question for you. Click "Reply" to answer it.

LEAVING NOTES
  Open the review notes panel, enter your name once, then on any slide pick
  what the note is about (Text, Image / graphic, Audio / narration,
  Interaction, Other) and type it. Each note records the slide and the point
  in the narration. Notes are saved in your browser, so you can stop and come
  back later on the same computer.
  When you're finished, click "Export all notes". The panel then shows the
  file's name (it's in your Downloads folder) and, if the author set one up,
  an "Open the shared notes folder" button: open it and drop the file in.
  Otherwise send the file back by email or Teams. Don't rename or edit it.

Nothing is installed and nothing is sent anywhere: the course runs on your own
computer at http://localhost.
`);
  // Put the staged course back to the delivery build so a review build can never ship.
  console.log(`\n== restoring the delivery build in output/course`);
  run('node', ['scripts/sync-output.js']);
  const zip = path.join(SHARE, `${CODE}-Review.zip`);
  console.log(`== zipping ${path.relative(ROOT, zip)}`);
  zipFolder(dir, zip);
  built.push(zip);
}

// ── LMS test copy ───────────────────────────────────────────────────────────
if (doLms) {
  console.log(`\n== ${CODE} LMS Test: packaging the SCORM zip`);
  run('node', ['scripts/sync-output.js']);
  run('node', ['scripts/package-scorm.js']);
  const report = JSON.parse(execFileSync(PY, ['scripts/preflight-palms.py', SCORM_ZIP, '--json'], { cwd: ROOT }).toString())[0];
  console.log(`   PALMS preflight: ${report.verdict}`);

  const dir = path.join(SHARE, `${CODE}-LMS-Test`);
  stageCommon(dir);
  const site = path.join(dir, '_files', 'site');
  // Unpack the exact zip that would be uploaded; the harness launches from it.
  execFileSync(PY, ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', SCORM_ZIP, path.join(site, 'palms-sim')]);
  // The verdict the hub's /api/palms-import would return, saved as a file.
  write(path.join(site, 'api', 'palms-import'), JSON.stringify(Object.assign({}, report, { simBase: '/palms-sim/' }), null, 2));
  // The harness, without its "Dev tree" mode (there is no dev tree in a shared copy).
  const harness = fs.readFileSync(path.join(__dirname, 'scorm-test-harness.html'), 'utf8')
    .replace('</head>', '<style>#mode-dev{display:none}</style>\n</head>');
  fs.writeFileSync(path.join(site, 'index.html'), harness);
  write(path.join(dir, `Open ${CODE} LMS Test.bat`), launcher(8792, '/', `${CODE} LMS Test`));
  write(path.join(dir, 'README.txt'), `${CODE} — LMS test copy
${'='.repeat(CODE.length + 18)}

This runs the exact SCORM package that gets uploaded to PALMS (PeopleFluent),
inside a test harness that behaves like PALMS: SCORM 1.2, the same upload
checks, the same 4096-character limit on saved progress, and resume between
sessions. The course is locked the way learners see it.

TO OPEN
  1. Unzip this folder anywhere. Don't open it from inside the zip.
  2. Double-click "Open ${CODE} LMS Test.bat" (choose "Run" if Windows asks).
  3. Keep the small black window open while testing; close it when done.

WHAT YOU SEE
  Top: the PALMS upload verdict (ACCEPT / WARN / REJECT) and package size.
  Middle: the course, as a learner launches it.
  Side panel: every SCORM call the course makes, status, score and saved
  progress (with its size against the 4096 limit).
  "Reset" clears saved progress so you can start as a new learner.

Built from: ${path.basename(SCORM_ZIP)} (${(report.meta.size_bytes / 1e6).toFixed(1)} MB, PALMS preflight ${report.verdict})
`);
  const zip = path.join(SHARE, `${CODE}-LMS-Test.zip`);
  console.log(`== zipping ${path.relative(ROOT, zip)}`);
  zipFolder(dir, zip);
  built.push(zip);
}

// ── Review copy as a SCORM package ──────────────────────────────────────────
// Same review player (free navigation, notes, author notes, upload link), zipped
// as SCORM so it can run in an LMS or from a SCORM Cloud invitation link.
if (doReviewScorm) {
  console.log(`\n== ${CODE} Review SCORM: packaging the review player`);
  run('node', ['scripts/sync-output.js', '--review']);
  const extras = addReviewExtras(path.join(OUT, 'course'));
  const slug = path.basename(ROOT).toLowerCase() + '-review';
  try {
    run('node', ['scripts/package-scorm.js', '--name', slug]);
  } finally {
    // Back to the delivery build, so neither the review player nor its extras can ship.
    extras.forEach((f) => rm(f));
    console.log(`\n== restoring the delivery build in output/course`);
    run('node', ['scripts/sync-output.js']);
  }
  const zip = path.join(SHARE, `${CODE}-Review-SCORM.zip`);
  rm(zip);
  fs.renameSync(path.join(OUT, `${slug}-scorm.zip`), zip);
  built.push(zip);
}

console.log('\nShare packages ready:');
for (const z of built) console.log(`  ${path.relative(ROOT, z)}  ${(fs.statSync(z).size / 1e6).toFixed(0)} MB`);
console.log('Send the zip; the README inside explains how to open it.\n');
