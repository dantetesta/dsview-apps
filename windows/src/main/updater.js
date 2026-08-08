/**
 * Auto-update via GitHub Releases (repo público dsview-apps). Sem servidor de update próprio: o
 * "latest" já existe de graça no GitHub, e cada release já carrega o instalador Windows versionado
 * no nome do arquivo (dsview-windows-setup-X.Y.Z.exe) — extrair a versão do NOME do asset, não da
 * tag do release, porque um release combina os dois apps (a tag pode ter mudado por causa só do
 * Android, sem nenhuma versão nova do Windows ali dentro).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { net, app } = require('electron');

const REPO = 'dantetesta/dsview-apps';
const ASSET_RE = /^dsview-windows-setup-(\d+\.\d+\.\d+)\.exe$/;

/** Compara "a" com "b" (semver simples X.Y.Z): >0 se a>b, <0 se a<b, 0 se igual. Pura — testável. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Acha o asset do Windows entre os assets de um release e extrai a versão do NOME do arquivo.
 * Pura — testável sem rede. */
function findWindowsAsset(assets) {
  for (const a of assets || []) {
    const m = ASSET_RE.exec(a.name || '');
    if (m) return { version: m[1], url: a.browser_download_url, size: a.size, name: a.name };
  }
  return null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('User-Agent', 'DSView-Updater');
    req.setHeader('Accept', 'application/vnd.github+json');
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.on('data', () => {}); return reject(new Error('GitHub respondeu HTTP ' + res.statusCode)); }
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Resposta inesperada do GitHub.')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Verifica o último release do GitHub e compara com a versão instalada. */
async function checkLatest() {
  const release = await fetchJson('https://api.github.com/repos/' + REPO + '/releases/latest');
  const asset = findWindowsAsset(release.assets);
  if (!asset) throw new Error('O último release não tem instalador do Windows.');
  const current = app.getVersion();
  return {
    current,
    latest: asset.version,
    available: compareVersions(asset.version, current) > 0,
    downloadUrl: asset.url,
    size: asset.size,
  };
}

/** Baixa o instalador para um arquivo temporário. onProgress(bytesRecebidos, bytesTotal). */
function download(url, onProgress) {
  return new Promise((resolve, reject) => {
    const dst = path.join(os.tmpdir(), 'dsview-update-' + Date.now() + '.exe');
    const out = fs.createWriteStream(dst);
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    let received = 0;
    let total = 0;
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      try { out.destroy(); } catch (_e2) { /* já morto */ }
      fs.unlink(dst, () => {});
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    req.on('response', (res) => {
      if (res.statusCode !== 200) return fail(new Error('HTTP ' + res.statusCode + ' ao baixar a atualização.'));
      total = Number(res.headers['content-length'] || 0);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => { if (!failed) resolve(dst); });
    });
    req.on('error', fail);
    req.end();
  });
}

module.exports = { compareVersions, findWindowsAsset, checkLatest, download };
