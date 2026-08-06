/**
 * Resolve o que o usuário cola no setup → { origin, token }.
 * Aceita:
 *   - https://site/play/{token}         (link canônico do player)
 *   - https://site/{12345}              (código curto → segue o 302 e extrai o token)
 *   - https://site  + código digitado   (tratado como código curto)
 * Usa o net do Electron (segue redirect e respeita proxy do SO).
 */
'use strict';
const { net } = require('electron');

function parsePlayUrl(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/play\/([A-Za-z0-9]+)\/?$/);
    if (m) return { origin: url.origin, token: m[1] };
  } catch (e) { /* não é URL */ }
  return null;
}

/** Faz um GET seguindo redirect e devolve a URL final (para resolver código curto → /play/{token}).
 *
 * PRECISA ser `redirect: 'manual'`. Com `redirect: 'follow'` o net do Electron segue os redirects
 * sozinho, silenciosamente — o evento 'redirect' não chega a disparar como esperado, então nada
 * aqui nunca sabia pra onde o 302 tinha ido. O 'response' final não é mais um redirect, então não
 * tem header `location` nenhum, e o código caía sempre no fallback `u` — a URL do CÓDIGO CURTO
 * original, que nunca bate com `/play/{token}`. Resultado: resolver código curto sempre falhava. */
function finalUrl(u) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: u, redirect: 'manual' });
    let lastUrl = u;
    let done = false;
    req.on('redirect', (status, method, redirectUrl) => {
      lastUrl = redirectUrl;
      req.followRedirect();
    });
    req.on('response', (res) => {
      // Consome o corpo para liberar o socket.
      res.on('data', () => {});
      res.on('end', () => { if (!done) { done = true; resolve(lastUrl); } });
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    req.end();
  });
}

/**
 * @param {string} input  URL colada OU código digitado.
 * @param {string} [origin] origin conhecido (quando o usuário digita só o código).
 * @returns {Promise<{origin:string, token:string}>}
 */
async function resolve(input, origin) {
  input = String(input || '').trim();

  // 1) Link canônico /play/{token}
  const direct = parsePlayUrl(input);
  if (direct) return direct;

  // 2) Descobre origin + o "código/caminho" a bater
  let base = origin;
  let codePath = input;
  try {
    const url = new URL(input);
    base = url.origin;
    codePath = url.href;
  } catch (e) {
    // input não é URL: é um código curto puro; precisa de origin.
    if (!base) throw new Error('Cole o link completo da playlist (ex.: https://site/play/xxxx).');
    codePath = base.replace(/\/$/, '') + '/' + encodeURIComponent(input.replace(/\D/g, ''));
  }

  // 3) Segue o redirect do código curto até /play/{token}
  const finalU = await finalUrl(codePath);
  const resolved = parsePlayUrl(finalU);
  if (resolved) return resolved;

  throw new Error('Não consegui resolver essa URL/código. Confira e tente de novo.');
}

module.exports = { resolve, parsePlayUrl };
