import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const APP_NAME = 'Antigravity Account Manager';
const BUNDLE_ID = 'com.feiyuggg.antigravity-account-manager';
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const BUILD_TMP_DIR = path.join(ROOT_DIR, 'build', 'macos-tmp');
const APP_BUNDLE_PATH = path.join(RELEASE_DIR, `${APP_NAME}.app`);
const DMG_PATH = path.join(RELEASE_DIR, `Antigravity-Account-Manager-${VERSION}-macOS-arm64.dmg`);
const ZIP_PATH = path.join(RELEASE_DIR, `Antigravity-Account-Manager-${VERSION}-macOS-arm64.zip`);
const SHA_PATH = path.join(RELEASE_DIR, 'SHA256SUMS.txt');

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function runCapture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options });
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderAppIconPng(size = 1024) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const half = size / 2;
  const cornerRadius = size * 0.225;
  const boxHalf = size * 0.44;

  function sdRoundedBox(px, py, bx, by, r) {
    const dx = Math.abs(px) - bx + r;
    const dy = Math.abs(py) - by + r;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  }

  function sdSegment(px, py, ax, ay, bx, by) {
    const pax = px - ax;
    const pay = py - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h);
  }

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (1 + size * 4);
    raw[rowOffset] = 0;
    const ny = y - half + 0.5;
    for (let x = 0; x < size; x += 1) {
      const nx = x - half + 0.5;
      const distBg = sdRoundedBox(nx, ny, boxHalf, boxHalf, cornerRadius);
      const alphaBg = Math.max(0, Math.min(1, 0.5 - distBg));
      if (alphaBg <= 0) {
        continue;
      }

      const t = (x + y) / (2 * size);
      let r = 13 + t * 20;
      let g = 24 + t * 44;
      let b = 46 + t * 68;

      const glowDist = Math.hypot(nx + size * 0.14, ny + size * 0.16) / (size * 0.55);
      const glow = Math.max(0, 1 - glowDist);
      r += glow * 26;
      g += glow * 88;
      b += glow * 135;

      const borderAlpha = Math.max(0, Math.min(1, 1 - Math.abs(distBg + 2) / 3)) * 0.25;
      r = r * (1 - borderAlpha) + 125 * borderAlpha;
      g = g * (1 - borderAlpha) + 211 * borderAlpha;
      b = b * (1 - borderAlpha) + 252 * borderAlpha;

      const ringDist = Math.abs(Math.hypot(nx, ny) - size * 0.27) - size * 0.022;
      const ringAlpha = Math.max(0, Math.min(1, 0.5 - ringDist)) * 0.35;
      r = r * (1 - ringAlpha) + 94 * ringAlpha;
      g = g * (1 - ringAlpha) + 234 * ringAlpha;
      b = b * (1 - ringAlpha) + 212 * ringAlpha;

      // Stylized dual-chevron "A" / account-switch emblem
      const dLeft = sdSegment(nx, ny, 0, -size * 0.23, -size * 0.19, size * 0.20);
      const dRight = sdSegment(nx, ny, 0, -size * 0.23, size * 0.19, size * 0.20);
      const dBar = sdSegment(nx, ny, -size * 0.11, size * 0.06, size * 0.11, size * 0.06);
      const stroke = Math.min(dLeft, dRight, dBar) - size * 0.036;
      const glyphAlpha = Math.max(0, Math.min(1, 0.5 - stroke));

      // Accent orbital dot (top-right)
      const dotDist = Math.hypot(nx - size * 0.20, ny + size * 0.20) - size * 0.052;
      const dotAlpha = Math.max(0, Math.min(1, 0.5 - dotDist));

      if (glyphAlpha > 0) {
        r = r * (1 - glyphAlpha) + 241 * glyphAlpha;
        g = g * (1 - glyphAlpha) + 248 * glyphAlpha;
        b = b * (1 - glyphAlpha) + 255 * glyphAlpha;
      }
      if (dotAlpha > 0) {
        r = r * (1 - dotAlpha) + 56 * dotAlpha;
        g = g * (1 - dotAlpha) + 189 * dotAlpha;
        b = b * (1 - dotAlpha) + 248 * dotAlpha;
      }

      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = Math.max(0, Math.min(255, Math.round(r)));
      raw[pxOffset + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[pxOffset + 2] = Math.max(0, Math.min(255, Math.round(b)));
      raw[pxOffset + 3] = Math.max(0, Math.min(255, Math.round(alphaBg * 255)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIcns(workDir) {
  const basePng = path.join(workDir, 'icon-1024.png');
  const iconsetDir = path.join(workDir, 'AppIcon.iconset');
  const icnsPath = path.join(workDir, 'AppIcon.icns');
  fs.mkdirSync(iconsetDir, { recursive: true });
  fs.writeFileSync(basePng, renderAppIconPng(1024));

  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  for (const [name, px] of sizes) {
    run('sips', ['-z', String(px), String(px), basePng, '--out', path.join(iconsetDir, name)], {
      stdio: 'ignore',
    });
  }
  run('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);
  return icnsPath;
}

function setPlistString(plistPath, key, value) {
  spawnSync('plutil', ['-replace', key, '-string', value, plistPath], { stdio: 'ignore' });
}

function removePlistKey(plistPath, key) {
  spawnSync('plutil', ['-remove', key, plistPath], { stdio: 'ignore' });
}

function configureAppBundle(icnsPath) {
  const contentsDir = path.join(APP_BUNDLE_PATH, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const frameworksDir = path.join(contentsDir, 'Frameworks');
  const mainPlist = path.join(contentsDir, 'Info.plist');

  // Remove Electron default_app.asar and copy compiled app files
  const defaultAsar = path.join(resourcesDir, 'default_app.asar');
  if (fs.existsSync(defaultAsar)) {
    fs.rmSync(defaultAsar, { force: true });
  }
  const oldElectronIcns = path.join(resourcesDir, 'electron.icns');
  if (fs.existsSync(oldElectronIcns)) {
    fs.rmSync(oldElectronIcns, { force: true });
  }
  fs.copyFileSync(icnsPath, path.join(resourcesDir, 'AppIcon.icns'));

  const appResourcesDir = path.join(resourcesDir, 'app');
  fs.mkdirSync(appResourcesDir, { recursive: true });
  run('/usr/bin/ditto', [path.join(ROOT_DIR, 'dist'), path.join(appResourcesDir, 'dist')]);
  run('/usr/bin/ditto', [path.join(ROOT_DIR, 'dist-electron'), path.join(appResourcesDir, 'dist-electron')]);

  const minimalPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'dist-electron/main.cjs',
    type: pkg.type,
    author: pkg.author,
    license: pkg.license,
  };
  fs.writeFileSync(path.join(appResourcesDir, 'package.json'), `${JSON.stringify(minimalPkg, null, 2)}\n`, 'utf8');

  // Rename main executable & update Info.plist
  fs.renameSync(path.join(macosDir, 'Electron'), path.join(macosDir, APP_NAME));
  removePlistKey(mainPlist, 'ElectronAsarIntegrity');
  setPlistString(mainPlist, 'CFBundleName', APP_NAME);
  setPlistString(mainPlist, 'CFBundleDisplayName', APP_NAME);
  setPlistString(mainPlist, 'CFBundleIdentifier', BUNDLE_ID);
  setPlistString(mainPlist, 'CFBundleExecutable', APP_NAME);
  setPlistString(mainPlist, 'CFBundleIconFile', 'AppIcon.icns');
  setPlistString(mainPlist, 'CFBundleShortVersionString', VERSION);
  setPlistString(mainPlist, 'CFBundleVersion', VERSION);
  setPlistString(mainPlist, 'LSApplicationCategoryType', 'public.app-category.developer-tools');
  setPlistString(mainPlist, 'NSHumanReadableCopyright', 'Copyright (c) 2026 feiyuggg. MIT License.');

  // Rename Helper bundles & update their Info.plists
  const helpers = [
    ['Electron Helper.app', `${APP_NAME} Helper.app`, 'Electron Helper', `${APP_NAME} Helper`, `${BUNDLE_ID}.helper`],
    ['Electron Helper (GPU).app', `${APP_NAME} Helper (GPU).app`, 'Electron Helper (GPU)', `${APP_NAME} Helper (GPU)`, `${BUNDLE_ID}.helper.GPU`],
    ['Electron Helper (Plugin).app', `${APP_NAME} Helper (Plugin).app`, 'Electron Helper (Plugin)', `${APP_NAME} Helper (Plugin)`, `${BUNDLE_ID}.helper.Plugin`],
    ['Electron Helper (Renderer).app', `${APP_NAME} Helper (Renderer).app`, 'Electron Helper (Renderer)', `${APP_NAME} Helper (Renderer)`, `${BUNDLE_ID}.helper.Renderer`],
  ];

  const renamedHelperPaths = [];
  for (const [oldBundle, newBundle, oldExec, newExec, helperId] of helpers) {
    const oldPath = path.join(frameworksDir, oldBundle);
    const newPath = path.join(frameworksDir, newBundle);
    if (!fs.existsSync(oldPath)) {
      continue;
    }
    fs.renameSync(oldPath, newPath);
    const helperPlist = path.join(newPath, 'Contents', 'Info.plist');
    const helperOldExec = path.join(newPath, 'Contents', 'MacOS', oldExec);
    const helperNewExec = path.join(newPath, 'Contents', 'MacOS', newExec);
    if (fs.existsSync(helperOldExec)) {
      fs.renameSync(helperOldExec, helperNewExec);
    }
    setPlistString(helperPlist, 'CFBundleName', newExec);
    setPlistString(helperPlist, 'CFBundleDisplayName', newExec);
    setPlistString(helperPlist, 'CFBundleIdentifier', helperId);
    setPlistString(helperPlist, 'CFBundleExecutable', newExec);
    renamedHelperPaths.push(newPath);
  }

  return renamedHelperPaths;
}

function codesignInsideOut(helperPaths) {
  const frameworksDir = path.join(APP_BUNDLE_PATH, 'Contents', 'Frameworks');
  const frameworks = [
    'Mantle.framework',
    'ReactiveObjC.framework',
    'Squirrel.framework',
    'Electron Framework.framework',
  ];

  for (const fw of frameworks) {
    const fwPath = path.join(frameworksDir, fw);
    if (fs.existsSync(fwPath)) {
      run('codesign', ['--force', '--sign', '-', fwPath]);
    }
  }
  for (const helperPath of helperPaths) {
    run('codesign', ['--force', '--sign', '-', helperPath]);
  }
  run('codesign', ['--force', '--sign', '-', APP_BUNDLE_PATH]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP_BUNDLE_PATH]);
}

function runStandaloneSmokeTest() {
  const binaryPath = path.join(APP_BUNDLE_PATH, 'Contents', 'MacOS', APP_NAME);
  const env = { ...process.env, ACP_MANAGER_SMOKE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const output = runCapture(binaryPath, [], { env });
  process.stdout.write(output);
  if (!output.includes('ELECTRON_SMOKE_OK')) {
    throw new Error(`Standalone .app smoke test failed; output did not contain ELECTRON_SMOKE_OK`);
  }
}

function buildDmgAndZip(workDir) {
  const dmgStage = path.join(workDir, 'dmg-stage');
  fs.mkdirSync(dmgStage, { recursive: true });
  run('/usr/bin/ditto', [APP_BUNDLE_PATH, path.join(dmgStage, `${APP_NAME}.app`)]);
  fs.symlinkSync('/Applications', path.join(dmgStage, 'Applications'));

  if (fs.existsSync(DMG_PATH)) fs.rmSync(DMG_PATH, { force: true });
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH, { force: true });

  run('hdiutil', [
    'create',
    '-volname',
    APP_NAME,
    '-srcfolder',
    dmgStage,
    '-ov',
    '-format',
    'UDZO',
    DMG_PATH,
  ]);

  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP_BUNDLE_PATH, ZIP_PATH]);

  const sums = runCapture('shasum', ['-a', '256', path.basename(DMG_PATH), path.basename(ZIP_PATH)], {
    cwd: RELEASE_DIR,
  });
  fs.writeFileSync(SHA_PATH, sums, 'utf8');
}

function main() {
  const electronApp = path.join(ROOT_DIR, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(electronApp)) {
    throw new Error('Electron.app not found in node_modules/electron/dist');
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'dist', 'index.html')) || !fs.existsSync(path.join(ROOT_DIR, 'dist-electron', 'main.cjs'))) {
    throw new Error('Build outputs missing; run npm run build first');
  }

  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  fs.rmSync(BUILD_TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.mkdirSync(BUILD_TMP_DIR, { recursive: true });

  try {
    console.log('1. Generating macOS AppIcon.icns...');
    const icnsPath = buildIcns(BUILD_TMP_DIR);

    console.log('2. Copying Electron.app template...');
    run('/usr/bin/ditto', [electronApp, APP_BUNDLE_PATH]);

    console.log('3. Configuring app bundle, Info.plist, and helpers...');
    const helperPaths = configureAppBundle(icnsPath);

    console.log('4. Signing and verifying bundle...');
    codesignInsideOut(helperPaths);

    console.log('5. Running standalone .app smoke test...');
    runStandaloneSmokeTest();

    console.log('6. Creating DMG, ZIP, and SHA256SUMS.txt...');
    buildDmgAndZip(BUILD_TMP_DIR);

    console.log('Done! Release artifacts in:', RELEASE_DIR);
  } finally {
    fs.rmSync(BUILD_TMP_DIR, { recursive: true, force: true });
  }
}

main();
