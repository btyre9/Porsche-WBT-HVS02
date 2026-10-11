#!/usr/bin/env python3
"""Preflight a SCORM zip against the gates PALMS actually enforces, before it is
handed to the employee who has upload rights.

This is not a SCORM conformance check -- SCORM Cloud already does that, and every
package here passes it. These are PeopleFluent/NetDimensions *instance* rules,
which is why a spec-valid package still comes back rejected:

  1. Container gate. The importer looks for imsmanifest.xml at the ZIP ROOT, then
     falls back to sniffing for a zip-of-zips, an AICC quad, and tincan.xml.
     Finding none it reports:
       "The specified file is not a valid SCORM, AICC, IMS or Tincan content
        package."
     A manifest one level deep (zipping output/ instead of output/course/) is the
     usual cause, and a truncated upload looks identical.

  2. Extension blocklist. A DIFFERENT error, easy to confuse with the above:
       "This zip file contains files whose filename is suspicious, or the type of
        file extension is configured by your administrator as a security risk."
     .svg trips this -- SVGs can carry script. See inline-svgs.js, which the
     packager runs to inline and strip them.

verify-packages.py deliberately tolerates a nested manifest (it computes a prefix
and compares against the staged tree anyway), so it cannot catch gate 1. This
script takes any zip on disk, needs no repo beside it, and prints a report that
can be pasted into the handoff mail.

Usage:
  python3 scripts/preflight-palms.py                       # every module zip under the root
  python3 scripts/preflight-palms.py path/to/one.zip ...   # specific files
  python3 scripts/preflight-palms.py --max-mb 100          # flag anything over the cap
  python3 scripts/preflight-palms.py one.zip --json        # machine-readable, for tooling
                                                             # (the dashboard's PALMS-import
                                                             # simulator calls this to decide
                                                             # whether to "install" the zip)

Exit code 0 only if every package checked would be accepted.
"""
import os, re, sys, glob, zipfile, json

# Extensions PALMS is known or likely to blocklist. .svg is confirmed; the rest
# are the usual suspects on a corporate content scanner. Kept deliberately short
# -- guessing wide would cry wolf on every package.
BLOCKED_EXTS = ('.svg', '.exe', '.bat', '.cmd', '.com', '.vbs', '.jar', '.msi', '.dll')

# Sniffer bait: presence of these makes the importer try to read the package as
# something other than SCORM, which fails in confusing ways.
AICC_EXTS = ('.au', '.crs', '.cst', '.des')

LFS_MAGIC = b'version https://git-lfs'


def human(n):
    return '%.1f MB' % (n / 1e6)


def find_module_dirs(root):
    """Module directories, matched case-insensitively -- porsche-wbt-cc08 is a
    real sibling repo, just not capitalized like the other eleven, and a
    case-sensitive glob silently drops it."""
    try:
        entries = os.listdir(root)
    except OSError:
        return []
    return sorted(
        os.path.join(root, d) for d in entries
        if re.match(r'porsche-wbt-cc\d+$', d, re.IGNORECASE) and os.path.isdir(os.path.join(root, d))
    )


def check(path, max_mb):
    """Return (fails, warns, facts, meta) for one zip. meta is the same
    information as facts, structured for callers that need to act on it (the
    dashboard's PALMS-import simulator, chiefly) instead of just printing it."""
    fails, warns, facts = [], [], []
    meta = {'size_bytes': None, 'file_count': None, 'scorm_version': None, 'launch': None}

    size = os.path.getsize(path)
    meta['size_bytes'] = size
    facts.append('size %s' % human(size))
    if max_mb and size > max_mb * 1e6:
        warns.append('%s exceeds the --max-mb %d ceiling -- confirm the instance limit with the uploader'
                     % (human(size), max_mb))

    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        return ['not a readable zip: %s (a truncated transfer looks like this)' % e], warns, facts, meta

    bad = zf.testzip()
    if bad is not None:
        fails.append('corrupt entry: %s' % bad)

    names = [n for n in zf.namelist() if not n.endswith('/')]
    meta['file_count'] = len(names)
    facts.append('%d files' % len(names))

    # -- Gate 1: container shape -------------------------------------------------
    manifests = [n for n in names if os.path.basename(n) == 'imsmanifest.xml']
    if 'imsmanifest.xml' not in names:
        if manifests:
            fails.append('imsmanifest.xml is at "%s", not the zip root -- PALMS will reject this as '
                         '"not a valid SCORM, AICC, IMS or Tincan content package". Zip the CONTENTS '
                         'of output/course, not the folder itself.' % manifests[0])
        else:
            fails.append('no imsmanifest.xml anywhere in the zip')
    elif len(manifests) > 1:
        warns.append('%d imsmanifest.xml files; only the root one is read' % len(manifests))

    nested = [n for n in names if n.lower().endswith('.zip')]
    if nested:
        fails.append('contains nested zip(s) (%s) -- the importer may read this as a '
                     'zip-of-packages instead of one package' % ', '.join(nested[:3]))

    bait = [n for n in names if n.lower().endswith(AICC_EXTS) or os.path.basename(n) == 'tincan.xml']
    if bait:
        warns.append('files that could misdirect the format sniffer: %s' % ', '.join(bait[:3]))

    # -- Gate 2: blocked extensions ---------------------------------------------
    blocked = [n for n in names if n.lower().endswith(BLOCKED_EXTS)]
    if blocked:
        svgs = [n for n in blocked if n.lower().endswith('.svg')]
        if svgs:
            fails.append('%d .svg file(s) still in the zip (e.g. %s) -- run inline-svgs.js before '
                         'packaging, or PALMS rejects the upload as a security risk'
                         % (len(svgs), svgs[0]))
        other = [n for n in blocked if not n.lower().endswith('.svg')]
        if other:
            fails.append('blocklisted extension(s): %s' % ', '.join(other[:3]))

    # -- Junk that should never ship -------------------------------------------
    junk = [n for n in names
            if os.path.basename(n).startswith('._')
            or os.path.basename(n) == '.DS_Store'
            or n.startswith('__MACOSX/')]
    if junk:
        warns.append('%d macOS sidecar/junk file(s), e.g. %s' % (len(junk), junk[0]))

    # -- The manifest has to describe something that exists ---------------------
    if 'imsmanifest.xml' in names:
        raw = zf.read('imsmanifest.xml').decode('utf8', 'replace')

        ver = re.search(r'<schemaversion>\s*([^<\s]+)\s*</schemaversion>', raw)
        facts.append('SCORM %s' % (ver.group(1) if ver else '?'))
        if not ver:
            fails.append('manifest declares no <schemaversion>')
        else:
            meta['scorm_version'] = ver.group(1)

        href = re.search(r'<resource[^>]*\bhref="([^"]+)"', raw)
        if not href:
            fails.append('manifest declares no launchable resource href')
        elif href.group(1) not in names:
            fails.append('launch file "%s" is named in the manifest but absent from the zip'
                         % href.group(1))
        else:
            facts.append('launch %s' % href.group(1))
            meta['launch'] = href.group(1)

        # Every <file href> the manifest promises must be present, or the LMS may
        # accept the package and then 404 mid-course.
        missing = [h for h in re.findall(r'<file[^>]*\bhref="([^"]+)"', raw) if h not in names]
        if missing:
            fails.append('%d file(s) declared in the manifest are missing: %s'
                         % (len(missing), ', '.join(missing[:3])))

    # -- Real media, not LFS stubs ---------------------------------------------
    stubs = [i.filename for i in zf.infolist()
             if 0 < i.file_size < 200 and not i.filename.endswith('/')
             and zf.read(i.filename)[:24].startswith(LFS_MAGIC)]
    if stubs:
        fails.append('%d git-LFS pointer file(s) instead of real media, e.g. %s'
                     % (len(stubs), stubs[0]))

    return fails, warns, facts, meta


def main():
    argv = sys.argv[1:]
    max_mb = 0
    if '--max-mb' in argv:
        i = argv.index('--max-mb')
        max_mb = int(argv[i + 1])
        del argv[i:i + 2]

    as_json = '--json' in argv
    if as_json:
        argv.remove('--json')

    targets, root = argv, None
    unpackaged = []
    if not targets:
        root = (os.environ.get('PORSCHE_WBT_ROOT')
                or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        module_dirs = find_module_dirs(root)
        targets = sorted(t for d in module_dirs for t in glob.glob(os.path.join(d, 'output', '*-scorm.zip')))
        if not targets:
            sys.exit('no *-scorm.zip found under %s -- pass zip paths explicitly.' % root)
        # A module with no zip is the easiest thing to miss: nothing to check means
        # nothing gets printed, and a silent pass reads as approval.
        packaged = set(os.path.basename(os.path.dirname(os.path.dirname(t))) for t in targets)
        unpackaged = sorted(os.path.basename(d) for d in module_dirs
                            if os.path.basename(d) not in packaged)

    def label(p):
        return os.path.relpath(p, root) if root else p

    worst = 0
    results = []
    for path in targets:
        if not os.path.isfile(path):
            worst = 2
            results.append({'path': label(path), 'verdict': 'REJECT',
                            'fails': ['file not found'], 'warns': [], 'meta': {}})
            if not as_json:
                print('%s\n  FAIL  file not found\n' % path)
            continue

        fails, warns, facts, meta = check(path, max_mb)
        verdict = 'REJECT' if fails else ('WARN' if warns else 'ACCEPT')
        results.append({'path': label(path), 'verdict': verdict,
                        'fails': fails, 'warns': warns, 'meta': meta})
        if not as_json:
            shown = 'REJECT' if fails else ('ok, with warnings' if warns else 'ACCEPT')
            print('%s\n  %s  (%s)' % (label(path), shown, ', '.join(facts)))
            for f in fails:
                print('  FAIL  %s' % f)
            for w in warns:
                print('  warn  %s' % w)
            print('')

        worst = max(worst, 2 if fails else (1 if warns else 0))

    for m in unpackaged:
        worst = 2
        results.append({'path': m, 'verdict': 'REJECT',
                        'fails': ['no *-scorm.zip in output/ -- nothing has been built to send'],
                        'warns': [], 'meta': {}})
        if not as_json:
            print('%s\n  FAIL  no *-scorm.zip in output/ -- nothing has been built to send\n' % m)

    if as_json:
        print(json.dumps(results, indent=2))
    else:
        print('PALMS would accept every package checked.' if worst == 0 else
              'Warnings only -- PALMS should accept these.' if worst == 1 else
              'AT LEAST ONE PACKAGE WOULD BE REJECTED. Do not send it yet.')
    sys.exit(0 if worst < 2 else 1)


if __name__ == '__main__':
    main()
