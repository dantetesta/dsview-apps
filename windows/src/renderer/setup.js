/**
 * Setup do WebView: cola URL/código → resolve → baixa tudo (preloader) → inicia o player.
 * Fala com o main só via window.dsf (preload). Sem Node aqui.
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const urlIn = $('url'), err = $('err'), loader = $('loader'), domainIn = $('domain'), urlLabel = $('url-label');
  const barFill = $('bar-fill'), loaderTitle = $('loader-title'), loaderSub = $('loader-sub');

  function showErr(msg) { err.textContent = msg; err.hidden = !msg; }
  function showLoader(on) { loader.hidden = !on; }

  // Feedback visual do autosave: os toggles/seletor de preferências salvam sozinhos (sem passar
  // pelo botão "Salvar e iniciar"), então sem isso o usuário não tem como saber que já gravou.
  const toast = $('toast');
  let toastTimer = null;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    toast.className = 'toast show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = 'toast';
      setTimeout(() => { toast.hidden = true; }, 250);
    }, 1600);
  }

  // Progresso do download vindo do main.
  dsf.onSyncStatus((s) => {
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
  });

  async function start(input) {
    input = (input || '').trim();
    if (!input) { showErr('Cole o link ou o código da playlist.'); return; }
    showErr('');
    const r = await dsf.resolveSave(input);
    if (!r.ok) { showErr(r.error || 'Não consegui usar essa URL.'); return; }
    await dsf.favAdd({ name: input, url: input });
    if ($('offline').checked) {
      showLoader(true);
      // Autentica (senha, se houver) → device de sessão eterna + baixa a mídia (o preloader mostra o progresso).
      const auth = await dsf.authenticate($('password').value);
      if (auth.status !== 'ok') {
        showLoader(false);
        if (auth.status === 'password') showErr('Essa playlist pede senha. Digite a senha e tente de novo.');
        else if (auth.status === 'expired') showErr('Plano expirado ou playlist indisponível.');
        else showErr('Não consegui conectar. Confira a internet e o link.');
        return;
      }
    }
    // Só-online: a página real do player pede a senha nativamente, se houver.
    await dsf.play(); // navega para o player (o loader some com a navegação).
  }

  async function renderFavs() {
    const favs = await dsf.favList();
    const ul = $('favs'), empty = $('favs-empty');
    ul.innerHTML = '';
    if (empty) empty.hidden = !!favs.length;
    for (const f of favs) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.innerHTML = '<span></span><small></small>';
      name.firstChild.textContent = f.name || f.url;
      name.lastChild.textContent = f.url;
      name.onclick = () => { urlIn.value = f.url; start(f.url); };
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remover favorito';
      del.onclick = async (e) => { e.stopPropagation(); await dsf.favRemove(f.url); renderFavs(); };
      li.appendChild(name); li.appendChild(del);
      ul.appendChild(li);
    }
  }

  function syncOfflineOpts() { $('offline-opts').style.opacity = $('offline').checked ? '' : '.45'; }

  // Com domínio configurado, a aba Básico pede só o código — sem ele, ainda aceita o link
  // completo (resolve.js entende os dois; aqui é só o texto que muda).
  function syncUrlField(domain) {
    if (domain) {
      urlLabel.textContent = 'Código da playlist';
      urlIn.placeholder = '12345';
    } else {
      urlLabel.textContent = 'Link ou código da playlist';
      urlIn.placeholder = 'https://seusite.com.br/play/xxxx  ou  12345';
    }
  }

  async function init() {
    const cfg = await dsf.getConfig();
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
  }

  $('go').onclick = () => start(urlIn.value);
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(urlIn.value); });
  $('fav').onclick = async () => {
    const v = urlIn.value.trim();
    if (!v) { showErr('Digite uma URL para favoritar.'); return; }
    await dsf.favAdd({ name: v, url: v });
    renderFavs();
  };
  // Encerrar o app: confirmação em 2 cliques (evita fechar o kiosk sem querer).
  let quitArmed = false, quitTimer = null;
  $('quit').onclick = () => {
    const btn = $('quit');
    if (!quitArmed) {
      quitArmed = true;
      btn.classList.add('armed');
      btn.textContent = '⏻ Clique de novo para encerrar';
      quitTimer = setTimeout(() => {
        quitArmed = false; btn.classList.remove('armed'); btn.textContent = '⏻ Encerrar o aplicativo';
      }, 3000);
      return;
    }
    clearTimeout(quitTimer);
    dsf.quit();
  };

  $('autostart').onchange = async (e) => {
    const aceito = await dsf.setAutostart(e.target.checked);
    if (e.target.checked && !aceito) {
      e.target.checked = false; // o Windows recusou (política/antivírus): não mentir para o usuário
    }
    showToast('✓ Definições salvas');
    atualizarAutostart();
  };

  /**
   * Diz o que ainda falta para a TV voltar sozinha. Marcar o interruptor só faz o app abrir DEPOIS
   * que alguém entra na conta do Windows. Sem login automático, uma queda de energia deixa a tela
   * parada na tela de bloqueio até alguém digitar a senha.
   */
  async function atualizarAutostart() {
    try {
      const st = await dsf.autostartStatus();
      const aviso = $('autostart-aviso');
      const ok = $('autostart-ok');
      if (!st.autostart) { aviso.hidden = true; ok.hidden = true; return; }

      if (!st.registrado) {
        aviso.hidden = false; ok.hidden = true;
        $('autostart-motivo').textContent = 'O Windows não aceitou registrar a abertura automática.';
        $('autostart-como').textContent =
          'Costuma ser antivírus ou política da empresa bloqueando programas na inicialização. Libere o DS View e marque de novo.';
        return;
      }
      if (st.autoLogin === false) {
        aviso.hidden = false; ok.hidden = true;
        $('autostart-motivo').textContent =
          'O app abre sozinho, mas só depois que alguém entra na conta do Windows. Numa queda de energia a tela fica na tela de bloqueio.';
        $('autostart-como').textContent =
          'Para ligar sozinho de verdade: aperte Windows+R, digite netplwiz e desmarque "Os usuários devem digitar um nome de usuário e senha".';
        return;
      }
      aviso.hidden = true; ok.hidden = false;
      ok.textContent = st.autoLogin
        ? 'Pronto: o Windows entra na conta sozinho e o DS View abre em seguida.'
        : 'Abertura automática registrada no Windows.';
    } catch {
      /* sem status: o interruptor continua funcionando */
    }
  }
  $('offline').onchange = (e) => { dsf.setOffline(e.target.checked); syncOfflineOpts(); showToast('✓ Definições salvas'); };
  $('interval').onchange = (e) => { dsf.setInterval(parseInt(e.target.value, 10)); showToast('✓ Definições salvas'); };
  domainIn.onchange = async () => {
    const baseDomain = await dsf.setDomain(domainIn.value);
    domainIn.value = baseDomain || '';
    syncUrlField(baseDomain);
    showToast('✓ Definições salvas');
  };
  $('clear').onclick = async () => {
    const btn = $('clear'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Limpando…';
    const r = await dsf.clearCache();
    btn.textContent = `Limpo (${r.removed || 0} arquivos)`;
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
  };

  // Abas Básico/Configurações: troca simples de classe + hidden, sem framework.
  (function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    function select(tab) {
      tabs.forEach((t) => {
        t.className = t === tab ? 'tab-btn active' : 'tab-btn';
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      const name = tab.getAttribute('data-tab');
      panels.forEach((p) => { p.hidden = p.getAttribute('data-panel') !== name; });
    }
    tabs.forEach((t) => { t.onclick = () => select(t); });
  })();

  init();
})();
