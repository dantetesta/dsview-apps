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
  var urlIn = $('url'), err = $('err'), loader = $('loader'), domainIn = $('domain'), urlLabel = $('url-label');
  var barFill = $('bar-fill'), loaderTitle = $('loader-title'), loaderSub = $('loader-sub');

  // Token de sessão injetado pelo LocalServer só nesta página (ver LocalServer.setupHtml()) — sem
  // ele, o servidor local recusa qualquer /dsf/* com 403. Impede que outro app/página no aparelho
  // chame a API de configuração do kiosk (trocar playlist, apagar cache) por trás.
  var DSF_TOKEN = (typeof window.DSF_TOKEN === 'string') ? window.DSF_TOKEN : '';

  function getJson(p) {
    return fetch(p, { cache: 'no-store', headers: { 'X-Dsf-Token': DSF_TOKEN } }).then(function (r) { return r.json(); });
  }
  function postJson(p, obj) {
    return fetch(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dsf-Token': DSF_TOKEN },
      body: JSON.stringify(obj || {})
    }).then(function (r) { return r.json(); });
  }

  function showErr(msg) { err.textContent = msg; err.hidden = !msg; }
  function showLoader(on) { loader.hidden = !on; }

  // Feedback visual do autosave: os toggles/seletor de preferências salvam sozinhos (sem passar
  // pelo botão "Salvar e iniciar"), então sem isso o usuário não tem como saber que já gravou.
  var toast = $('toast'), toastTimer = null;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    toast.className = 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.className = 'toast';
      setTimeout(function () { toast.hidden = true; }, 250);
    }, 1600);
  }

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
      var ul = $('favs'), empty = $('favs-empty');
      ul.innerHTML = '';
      if (empty) empty.hidden = !!favs.length;
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

  // Com domínio configurado, a aba Básico pede só o código — sem ele, ainda aceita o link
  // completo (Resolver.resolve entende os dois; aqui é só o texto que muda).
  function syncUrlField(domain) {
    if (domain) {
      urlLabel.textContent = 'Código da playlist';
      urlIn.placeholder = '12345';
    } else {
      urlLabel.textContent = 'Link ou código da playlist';
      urlIn.placeholder = 'https://seusite.com.br/play/xxxx  ou  12345';
    }
  }

  function init() {
    getJson('/dsf/config').then(function (cfg) {
      if (cfg.lastUrl) urlIn.value = cfg.lastUrl;
      domainIn.value = cfg.baseDomain || '';
      syncUrlField(cfg.baseDomain);
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
    postJson('/dsf/autostart', { on: e.target.checked }).then(function () {
      showToast('✓ Definições salvas');
      atualizarAutostart();
    });
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
          ? 'Abertura automática garantida: este app é a tela inicial do aparelho.'
          : 'Abertura automática configurada (permissão de sobreposição concedida).';
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

  // Fechar o app: confirmação em 2 toques (mesmo padrão do "Remover aplicativo" logo abaixo e do
  // botão "Encerrar o aplicativo" do app Windows). Solta o HOME e encerra — não desinstala nada.
  var quitArmed = false, quitTimer = null;
  $('quit').onclick = function () {
    var btn = $('quit');
    if (!quitArmed) {
      quitArmed = true;
      btn.classList.add('armed');
      btn.textContent = '⏻ Toque de novo para fechar';
      quitTimer = setTimeout(function () {
        quitArmed = false; btn.classList.remove('armed'); btn.textContent = '⏻ Fechar aplicativo';
      }, 3000);
      return;
    }
    clearTimeout(quitTimer);
    postJson('/dsf/exit', {});
  };

  // Remover o app: confirmação em 2 toques (mesmo padrão do app Windows) — ação rara e séria.
  // O Android sempre pede a confirmação DELE mesmo depois (não dá pra apagar sem o usuário topar),
  // isto só evita o caminho manual Configurações > Apps > DS View > Desinstalar.
  var uninstallArmed = false, uninstallTimer = null;
  $('uninstall').onclick = function () {
    var btn = $('uninstall');
    if (!uninstallArmed) {
      uninstallArmed = true;
      btn.classList.add('armed');
      btn.textContent = '🗑 Toque de novo para remover';
      uninstallTimer = setTimeout(function () {
        uninstallArmed = false; btn.classList.remove('armed'); btn.textContent = '🗑 Remover aplicativo';
      }, 3000);
      return;
    }
    clearTimeout(uninstallTimer);
    uninstallArmed = false; btn.classList.remove('armed'); btn.textContent = '🗑 Remover aplicativo';
    postJson('/dsf/uninstall', {}).then(function (res) {
      if (!res || !res.ok) showToast((res && res.error) || 'Não consegui abrir a tela de remoção.');
    });
  };

  // ---------------------------------------------------------------- atualização (engrenagem)
  function fmtBytes(n) {
    if (!n) return '';
    var mb = n / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }

  var updUrl = null;
  var updStatusTimer = null;
  var updCheckBtn = $('upd-check'), updStatus = $('upd-status'), updInstallRow = $('upd-install-row');
  var updInstallBtn = $('upd-install'), updProgressWrap = $('upd-progress-wrap'), updProgress = $('upd-progress');

  getJson('/dsf/app-version').then(function (r) {
    $('upd-current').textContent = 'v' + (r.version || '?');
  }).catch(function () {});

  updCheckBtn.onclick = function () {
    updCheckBtn.disabled = true;
    updInstallRow.hidden = true;
    updStatus.textContent = 'Verificando…';
    postJson('/dsf/update-check', {}).then(function (res) {
      updCheckBtn.disabled = false;
      if (res.current) $('upd-current').textContent = 'v' + res.current;
      if (!res.ok) {
        updStatus.textContent = 'Não consegui verificar: ' + (res.error || 'erro desconhecido.');
        return;
      }
      if (res.available) {
        updUrl = res.downloadUrl;
        updStatus.textContent = 'Versão nova disponível: v' + res.latest + (res.size ? ' (' + fmtBytes(res.size) + ')' : '') + '.';
        updInstallRow.hidden = false;
      } else {
        updStatus.textContent = 'Você já está na versão mais recente.';
      }
    });
  };

  updInstallBtn.onclick = function () {
    if (!updUrl) return;
    updInstallBtn.disabled = true;
    updCheckBtn.disabled = true;
    updProgressWrap.hidden = false;
    updStatus.textContent = 'Baixando a atualização…';
    postJson('/dsf/update-install', { url: updUrl }).then(function (res) {
      if (!res || !res.ok) {
        updInstallBtn.disabled = false;
        updCheckBtn.disabled = false;
        updStatus.textContent = 'Falha ao atualizar: ' + ((res && res.error) || 'erro desconhecido.');
        return;
      }
      pollUpdateStatus();
    });
  };

  // Mesmo padrão do progresso de sync (poll a cada 500ms) — HTTP local não empurra evento sozinho.
  function pollUpdateStatus() {
    getJson('/dsf/update-status').then(function (s) {
      if (!s || !s.phase) return;
      if (s.phase === 'downloading' && s.total) {
        updProgress.style.width = Math.round((s.received / s.total) * 100) + '%';
        updStatus.textContent = 'Baixando… ' + fmtBytes(s.received) + ' de ' + fmtBytes(s.total);
        updStatusTimer = setTimeout(pollUpdateStatus, 500);
      } else if (s.phase === 'installing') {
        updStatus.textContent = 'Abrindo o instalador…';
        // fim do polling: a tela de instalação do sistema assume a partir daqui.
      } else if (s.phase === 'error') {
        updInstallBtn.disabled = false;
        updCheckBtn.disabled = false;
        updStatus.textContent = 'Falha ao atualizar: ' + (s.error || 'erro desconhecido.');
      } else {
        updStatusTimer = setTimeout(pollUpdateStatus, 500);
      }
    }).catch(function () {
      updStatusTimer = setTimeout(pollUpdateStatus, 500);
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) atualizarAutostart(); // voltou da tela do sistema: reavalia
  });
  $('offline').onchange = function (e) {
    postJson('/dsf/offline', { on: e.target.checked }).then(function () { showToast('✓ Definições salvas'); });
    syncOfflineOpts();
  };
  $('interval').onchange = function (e) {
    postJson('/dsf/interval', { minutes: parseInt(e.target.value, 10) }).then(function () { showToast('✓ Definições salvas'); });
  };
  domainIn.onchange = function () {
    postJson('/dsf/domain', { value: domainIn.value }).then(function (r) {
      domainIn.value = r.baseDomain || '';
      syncUrlField(r.baseDomain);
      showToast('✓ Definições salvas');
    });
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

  // Abas Básico/Configurações: troca simples de classe + hidden, sem framework.
  (function initTabs() {
    var tabs = document.querySelectorAll('.tab-btn');
    var panels = document.querySelectorAll('.tab-panel');
    function select(tab) {
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = tabs[i] === tab ? 'tab-btn active' : 'tab-btn';
        tabs[i].setAttribute('aria-selected', tabs[i] === tab ? 'true' : 'false');
      }
      var name = tab.getAttribute('data-tab');
      for (var j = 0; j < panels.length; j++) {
        panels[j].hidden = panels[j].getAttribute('data-panel') !== name;
      }
    }
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].onclick = (function (t) { return function () { select(t); }; })(tabs[k]);
    }
  })();

  init();
})();
