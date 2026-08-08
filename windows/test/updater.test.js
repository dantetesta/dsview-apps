'use strict';
require('./_stub-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const updater = require('../src/main/updater');

test('compareVersions: maior patch vence', () => {
  assert.equal(updater.compareVersions('0.4.3', '0.4.2'), 1);
});

test('compareVersions: menor patch perde', () => {
  assert.equal(updater.compareVersions('0.4.1', '0.4.2'), -1);
});

test('compareVersions: igual dá zero', () => {
  assert.equal(updater.compareVersions('0.4.2', '0.4.2'), 0);
});

test('compareVersions: minor/major pesam mais que patch', () => {
  assert.equal(updater.compareVersions('0.5.0', '0.4.99'), 1);
  assert.equal(updater.compareVersions('1.0.0', '0.99.99'), 1);
});

test('findWindowsAsset: acha o instalador do Windows entre vários assets do release', () => {
  const assets = [
    { name: 'dsview-android-0.5.5.apk', browser_download_url: 'https://x/android-versioned.apk', size: 100 },
    { name: 'dsview-android.apk', browser_download_url: 'https://x/android.apk', size: 100 },
    { name: 'dsview-windows-setup-0.4.3.exe', browser_download_url: 'https://x/win-versioned.exe', size: 78000000 },
    { name: 'dsview-windows-setup.exe', browser_download_url: 'https://x/win.exe', size: 78000000 },
  ];
  const found = updater.findWindowsAsset(assets);
  assert.equal(found.version, '0.4.3');
  assert.equal(found.url, 'https://x/win-versioned.exe');
  assert.equal(found.size, 78000000);
});

test('findWindowsAsset: release sem instalador do Windows devolve null', () => {
  const assets = [{ name: 'dsview-android-0.5.5.apk', browser_download_url: 'https://x/a.apk', size: 1 }];
  assert.equal(updater.findWindowsAsset(assets), null);
});

test('findWindowsAsset: lista vazia/undefined devolve null sem lançar', () => {
  assert.equal(updater.findWindowsAsset([]), null);
  assert.equal(updater.findWindowsAsset(undefined), null);
});
