/**
 * Setup do DS View: cola URL/código → resolve → autentica (senha) → baixa (preloader) → inicia o player.
 * Fala com o servidor local (127.0.0.1) via fetch nos endpoints /dsf/*.
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const urlIn = $('url'), err = $('err'), loader = $('loader');
  const barFill = $('bar-fill'), loaderTitle = $('loader-title'), loaderSub = $('loader-sub');

  const getJson = (p) => fetch(p, { cache: 'no-store' }).then((r) => r.json());
  const postJson = (p, obj) => fetch(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}),
  }).then((r) => r.json());

  function showErr(msg) { err.textContent = msg; err.hidden = !msg; }
  function showLoader(on) { loader.hidden = !on; }

  // Progresso do download (polling do status enquanto autentica/sincroniza).
  function pollStatus() {
    getJson('/dsf/sync-status').then((s) => {
      if (!s) return;
      if (s.phase === 'downloading' && s.total) {
        loaderTitle.textContent = 'Baixando o conteúdo…';
        loaderSub.textContent = `Mídia ${s.current} de ${s.total}`;
        barFill.style.width = Math.round((s.current / s.total) * 100) + '%';
      } else if (s.phase === 'offline') {
        loaderTitle.textContent = 'Sem internet';
        loaderSub.textContent = 'Vou tocar o que já está salvo.';
      } else if (s.phase === 'ready') {
        barFill.style.width = '100%';
        loaderSub.textContent = 'Pronto!';
      }
    }).catch(() => {});
  }

  async function start(input) {
    input = (input || '').trim();
    if (!input) { showErr('Cole o link ou o código da playlist.'); return; }
    showErr('');
    const r = await postJson('/dsf/resolve', { input });
    if (!r.ok) { showErr(r.error || 'Não consegui usar essa URL.'); return; }
    await postJson('/dsf/favorites', { name: input, url: input });

    const offline = $('offline').checked;
    if (offline) {
      showLoader(true);
      const poll = setInterval(pollStatus, 500);
      const auth = await postJson('/dsf/authenticate', { password: $('password').value });
      clearInterval(poll);
      if (auth.status !== 'ok') {
        showLoader(false);
        if (auth.status === 'password') showErr('Essa playlist pede senha. Digite a senha e tente de novo.');
        else if (auth.status === 'expired') showErr('Plano expirado ou playlist indisponível.');
        else showErr('Não consegui conectar. Confira a internet e o link.');
        return;
      }
    }

    const cfg = await getJson('/dsf/config');
    if (offline) {
      location.href = '/player?token=' + encodeURIComponent(cfg.token) + '&device=' + encodeURIComponent(cfg.device || '');
    } else {
      // Só-online: a página real do player pede a senha nativamente, se houver.
      location.href = String(cfg.origin || '').replace(/\/$/, '') + '/play/' + encodeURIComponent(cfg.token);
    }
  }

  async function renderFavs() {
    const data = await getJson('/dsf/favorites');
    const favs = data.favorites || [];
    const wrap = $('favs-wrap'), ul = $('favs');
    ul.innerHTML = '';
    wrap.hidden = !favs.length;
    for (const f of favs) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.innerHTML = '<span></span><small></small>';
      name.firstChild.textContent = f.name || f.url;
      name.lastChild.textContent = f.url;
      // Controle remoto: um <span> não entra na navegação por DPAD sem tabindex, e OK/Enter
      // chega como keydown, não como click.
      name.tabIndex = 0;
      name.onclick = () => { urlIn.value = f.url; start(f.url); };
      name.onkeydown = (e) => { if (e.key === 'Enter' || e.keyCode === 13) name.onclick(); };
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remover favorito';
      del.onclick = async (e) => { e.stopPropagation(); await postJson('/dsf/favorites/remove', { url: f.url }); renderFavs(); };
      li.appendChild(name); li.appendChild(del);
      ul.appendChild(li);
    }
  }

  function syncOfflineOpts() { $('offline-opts').style.opacity = $('offline').checked ? '' : '.45'; }

  async function init() {
    const cfg = await getJson('/dsf/config');
    if (cfg.lastUrl) urlIn.value = cfg.lastUrl;
    $('autostart').checked = !!cfg.autostart;
    atualizarAutostart();
    $('offline').checked = cfg.offline !== false;
    $('interval').value = String(cfg.syncInterval || 60);
    syncOfflineOpts();
    renderFavs();
    urlIn.focus();
  }

  $('go').onclick = () => start(urlIn.value);
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(urlIn.value); });
  $('fav').onclick = async () => {
    const v = urlIn.value.trim();
    if (!v) { showErr('Digite uma URL para favoritar.'); return; }
    await postJson('/dsf/favorites', { name: v, url: v });
    renderFavs();
  };
  $('autostart').onchange = async (e) => {
    await postJson('/dsf/autostart', { on: e.target.checked });
    atualizarAutostart();
  };

  /**
   * Mostra o que ainda falta para o auto-start funcionar de verdade. Ligar o interruptor grava a
   * preferência, mas no Android 10+ o sistema só deixa o app abrir sozinho se ele for a tela
   * inicial ou tiver a permissão de sobreposição.
   */
  async function atualizarAutostart() {
    try {
      const st = await getJson('/dsf/autostart-status');
      const aviso = $('autostart-aviso');
      const ok = $('autostart-ok');
      const precisa = st.autostart && st.precisaOverlay;
      aviso.hidden = !precisa;
      ok.hidden = !(st.autostart && !precisa);
      if (st.autostart && !precisa) {
        ok.textContent = st.isHome
          ? 'Auto-start garantido: este app é a tela inicial do aparelho.'
          : 'Auto-start configurado (permissão de sobreposição concedida).';
      }
      if (st.ultimoBoot) {
        ok.textContent = (ok.textContent || '') + ' Último boot: ' + st.ultimoBoot + '.';
      }
    } catch {
      /* sem status: o interruptor continua funcionando */
    }
  }

  $('btn-home').onclick = () => postJson('/dsf/autostart-home', {});
  $('btn-overlay').onclick = () => postJson('/dsf/autostart-permitir', {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) atualizarAutostart(); // voltou da tela do sistema: reavalia
  });
  $('offline').onchange = (e) => { postJson('/dsf/offline', { on: e.target.checked }); syncOfflineOpts(); };
  $('interval').onchange = (e) => postJson('/dsf/interval', { minutes: parseInt(e.target.value, 10) });
  $('clear').onclick = async () => {
    const btn = $('clear'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Limpando…';
    const r = await postJson('/dsf/clear', {});
    btn.textContent = `Limpo (${r.removed || 0} arquivos)`;
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
  };

  init();
})();
