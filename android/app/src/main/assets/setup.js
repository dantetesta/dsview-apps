/**
 * Setup do DS View: cola URL/código → resolve → autentica (senha) → baixa (preloader) → inicia o player.
 * Fala com o servidor local (127.0.0.1) via fetch nos endpoints /dsf/*.
 *
 * ESCRITO EM ES5 DE PROPÓSITO (var, function, sem template literal, sem async/await, catch com
 * variável). O WebView de TV box barato costuma ser velho: um Android 7 traz Chrome ~51, que NÃO
 * entende `async function` — e um único erro de sintaxe derruba o arquivo inteiro, deixando a tela
 * de setup morta sem explicação. O player.js do plugin segue o mesmo nível; não suba a régua aqui.
 */
'use strict';
(function () {
  function $(id) { return document.getElementById(id); }
  var urlIn = $('url'), err = $('err'), loader = $('loader');
  var barFill = $('bar-fill'), loaderTitle = $('loader-title'), loaderSub = $('loader-sub');

  function getJson(p) {
    return fetch(p, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function postJson(p, obj) {
    return fetch(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj || {})
    }).then(function (r) { return r.json(); });
  }

  function showErr(msg) { err.textContent = msg; err.hidden = !msg; }
  function showLoader(on) { loader.hidden = !on; }

  // Progresso do download (polling do status enquanto autentica/sincroniza).
  function pollStatus() {
    getJson('/dsf/sync-status').then(function (s) {
      if (!s) return;
      if (s.phase === 'downloading' && s.total) {
        loaderTitle.textContent = 'Baixando o conteúdo…';
        loaderSub.textContent = 'Mídia ' + s.current + ' de ' + s.total;
        barFill.style.width = Math.round((s.current / s.total) * 100) + '%';
      } else if (s.phase === 'offline') {
        loaderTitle.textContent = 'Sem internet';
        loaderSub.textContent = 'Vou tocar o que já está salvo.';
      } else if (s.phase === 'ready') {
        barFill.style.width = '100%';
        loaderSub.textContent = 'Pronto!';
      }
    }).catch(function () {});
  }

  function start(input) {
    input = (input || '').trim();
    if (!input) { showErr('Cole o link ou o código da playlist.'); return; }
    showErr('');
    var offline = $('offline').checked;

    postJson('/dsf/resolve', { input: input }).then(function (r) {
      if (!r.ok) { showErr(r.error || 'Não consegui usar essa URL.'); return false; }
      return postJson('/dsf/favorites', { name: input, url: input }).then(function () {
        if (!offline) return true;
        showLoader(true);
        var poll = setInterval(pollStatus, 500);
        return postJson('/dsf/authenticate', { password: $('password').value }).then(function (auth) {
          clearInterval(poll);
          if (auth.status === 'ok') return true;
          showLoader(false);
          if (auth.status === 'password') showErr('Essa playlist pede senha. Digite a senha e tente de novo.');
          else if (auth.status === 'expired') showErr('Plano expirado ou playlist indisponível.');
          else showErr('Não consegui conectar. Confira a internet e o link.');
          return false;
        });
      });
    }).then(function (segue) {
      if (!segue) return null;
      return getJson('/dsf/config').then(function (cfg) {
        if (offline) {
          location.href = '/player?token=' + encodeURIComponent(cfg.token) + '&device=' + encodeURIComponent(cfg.device || '');
        } else {
          // Só-online: a página real do player pede a senha nativamente, se houver.
          location.href = String(cfg.origin || '').replace(/\/$/, '') + '/play/' + encodeURIComponent(cfg.token);
        }
      });
    }).catch(function () {
      showLoader(false);
      showErr('Não consegui conectar. Confira a internet e o link.');
    });
  }

  function renderFavs() {
    getJson('/dsf/favorites').then(function (data) {
      var favs = (data && data.favorites) || [];
      var wrap = $('favs-wrap'), ul = $('favs');
      ul.innerHTML = '';
      wrap.hidden = !favs.length;
      for (var i = 0; i < favs.length; i++) {
        montaFavorito(ul, favs[i]);
      }
    }).catch(function () {});
  }

  function montaFavorito(ul, f) {
    var li = document.createElement('li');
    var name = document.createElement('span');
    name.className = 'name';
    name.innerHTML = '<span></span><small></small>';
    name.firstChild.textContent = f.name || f.url;
    name.lastChild.textContent = f.url;
    // Controle remoto: um <span> não entra na navegação por DPAD sem tabindex, e OK/Enter
    // chega como keydown, não como click.
    name.tabIndex = 0;
    name.onclick = function () { urlIn.value = f.url; start(f.url); };
    name.onkeydown = function (e) { if (e.key === 'Enter' || e.keyCode === 13) name.onclick(); };
    var del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Remover favorito';
    del.onclick = function (e) {
      e.stopPropagation();
      postJson('/dsf/favorites/remove', { url: f.url }).then(renderFavs);
    };
    li.appendChild(name);
    li.appendChild(del);
    ul.appendChild(li);
  }

  function syncOfflineOpts() { $('offline-opts').style.opacity = $('offline').checked ? '' : '.45'; }

  function init() {
    getJson('/dsf/config').then(function (cfg) {
      if (cfg.lastUrl) urlIn.value = cfg.lastUrl;
      $('autostart').checked = !!cfg.autostart;
      atualizarAutostart();
      $('offline').checked = cfg.offline !== false;
      $('interval').value = String(cfg.syncInterval || 60);
      syncOfflineOpts();
      renderFavs();
      urlIn.focus();
    }).catch(function () {
      showErr('Não consegui falar com o app. Feche e abra de novo.');
    });
  }

  $('go').onclick = function () { start(urlIn.value); };
  urlIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(urlIn.value); });
  $('fav').onclick = function () {
    var v = urlIn.value.trim();
    if (!v) { showErr('Digite uma URL para favoritar.'); return; }
    postJson('/dsf/favorites', { name: v, url: v }).then(renderFavs);
  };
  $('autostart').onchange = function (e) {
    postJson('/dsf/autostart', { on: e.target.checked }).then(atualizarAutostart);
  };

  /**
   * Mostra o que ainda falta para o auto-start funcionar de verdade. Ligar o interruptor grava a
   * preferência, mas no Android 10+ o sistema só deixa o app abrir sozinho se ele for a tela
   * inicial ou tiver a permissão de sobreposição.
   */
  function atualizarAutostart() {
    getJson('/dsf/autostart-status').then(function (st) {
      var aviso = $('autostart-aviso');
      var ok = $('autostart-ok');
      var precisa = st.autostart && st.precisaOverlay;
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
    }).catch(function () {
      /* sem status: o interruptor continua funcionando */
    });
  }

  $('btn-home').onclick = function () { postJson('/dsf/autostart-home', {}); };
  $('btn-overlay').onclick = function () { postJson('/dsf/autostart-permitir', {}); };
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) atualizarAutostart(); // voltou da tela do sistema: reavalia
  });
  $('offline').onchange = function (e) {
    postJson('/dsf/offline', { on: e.target.checked });
    syncOfflineOpts();
  };
  $('interval').onchange = function (e) {
    postJson('/dsf/interval', { minutes: parseInt(e.target.value, 10) });
  };
  $('clear').onclick = function () {
    var btn = $('clear'), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Limpando…';
    postJson('/dsf/clear', {}).then(function (r) {
      btn.textContent = 'Limpo (' + (r.removed || 0) + ' arquivos)';
      setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 2500);
    });
  };

  init();
})();
