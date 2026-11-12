/*
 * DCV-JL — Modo offline (página publicada no GitHub).
 * Fica entre a página e a API do sistema:
 *  - com internet: funciona normalmente e guarda no celular uma cópia das consultas (listas, telas, login);
 *  - sem internet: usa essa cópia e coloca os lançamentos (despesas e horas extras) numa fila no celular;
 *  - quando a internet volta: envia a fila sozinho, na ordem, sem duplicar (cada lançamento tem chave única).
 * Aprovações, conferência, RH e folha continuam exigindo internet. As regras são conferidas pelo servidor no envio.
 */
(function () {
  'use strict';
  if (!window.fetch || !window.indexedDB || !window.Promise || !window.Response) return;

  var LEITURAS = ['sistema.info', 'auth.sessao', 'ui.modulos', 'aux.listas', 'despesas.retiradas', 'despesas.listar', 'despesas.detalhe',
    'rh.heMinhas', 'notificacoes.listar', 'painel.dados', 'vales.listar', 'frequencia.listar', 'cartoes.listar', 'empresa.dados'];
  var FILA = { 'despesas.lancar': 'Despesa', 'rh.heSolicitar': 'Hora extra' };
  var CHAVE_TOKEN = 'dcvjl_token';
  var fetchOriginal = window.fetch.bind(window);
  var usuarioAtual = null, enviando = false, online = navigator.onLine !== false, sessaoExpirada = false;

  /* ---------- Armazenamento no celular (IndexedDB) ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('dcvjl-offline', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('fila')) d.createObjectStore('fila', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'k' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, modo, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, modo), req = fn(t.objectStore(store));
        t.oncomplete = function () { res(req ? req.result : undefined); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  function cacheGet(k) { return tx('cache', 'readonly', function (s) { return s.get(k); }).then(function (x) { return x || null; }, function () { return null; }); }
  function cachePut(k, v) { return tx('cache', 'readwrite', function (s) { return s.put({ k: k, v: v, em: Date.now() }); }).then(null, function () {}); }
  function cacheLimpar() { return tx('cache', 'readwrite', function (s) { return s.clear(); }).then(null, function () {}); }
  function filaTodos() {
    return tx('fila', 'readonly', function (s) { return s.getAll(); })
      .then(function (l) { return (l || []).sort(function (a, b) { return a.criadoEm - b.criadoEm; }); }, function () { return []; });
  }
  function filaPut(item) { return tx('fila', 'readwrite', function (s) { return s.put(item); }); }
  function filaDel(id) { return tx('fila', 'readwrite', function (s) { return s.delete(id); }); }

  /* ---------- Utilidades ---------- */
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2); }
  function resposta(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function ehApi(url) { var api = window.DCV_API_URL; return !!api && typeof url === 'string' && url.indexOf(api) === 0; }
  function tokenAtual() { try { return localStorage.getItem(CHAVE_TOKEN); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function moeda(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function toast(t, tipo) { if (window.DCV && window.DCV.toast) window.DCV.toast(t, tipo); }
  function lerUsuario(acao, dados) {
    if (acao === 'auth.sessao' && dados && dados.id) return { id: dados.id, nome: dados.nome };
    if (acao === 'auth.login' && dados && dados.usuario && dados.usuario.id) return { id: dados.usuario.id, nome: dados.usuario.nome };
    return null;
  }
  function definirUsuario(u, doCache) {
    var mudou = !usuarioAtual || usuarioAtual.id !== u.id;
    usuarioAtual = u;
    if (!doCache) { sessaoExpirada = false; cachePut('usuario', u); if (mudou) setTimeout(sincronizar, 1500); }
    atualizarAviso();
  }
  function marcarOnline(v) { if (online !== v) { online = v; atualizarAviso(); if (v) setTimeout(sincronizar, 1000); } }
  function rodapeVersao(dados) {
    var el = document.getElementById('rodape-versao');
    if (el && dados && dados.versao) el.textContent = 'JL INOX · DCV-JL ' + dados.versao;
  }

  /* ---------- Intermediário da API ---------- */
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (!ehApi(url) || !init || String(init.method).toUpperCase() !== 'POST') return fetchOriginal(input, init);
    var corpo;
    try { corpo = JSON.parse(init.body); } catch (e) { return fetchOriginal(input, init); }
    var acao = corpo.acao;
    if (FILA[acao]) return enviarOuGuardar(input, init, corpo);
    if (LEITURAS.indexOf(acao) >= 0) return lerComCache(input, init, corpo);
    if (acao === 'auth.logout') { cacheLimpar(); usuarioAtual = null; }
    return fetchOriginal(input, init).then(function (r) {
      marcarOnline(true);
      if (acao === 'auth.login') r.clone().json().then(function (j) { var u = j && j.ok && lerUsuario(acao, j.dados); if (u) definirUsuario(u); }, function () {});
      return r;
    }, function (e) { marcarOnline(false); throw e; });
  };

  function lerComCache(input, init, corpo) {
    var k = corpo.acao + '|' + JSON.stringify(corpo.dados || {});
    return fetchOriginal(input, init).then(function (r) {
      marcarOnline(true);
      r.clone().json().then(function (j) {
        if (!j || !j.ok) { if (j && j.codigo === 'SESSAO_EXPIRADA') { sessaoExpirada = true; atualizarAviso(); } return; }
        cachePut(k, j);
        var u = lerUsuario(corpo.acao, j.dados);
        if (u) definirUsuario(u);
        if (corpo.acao === 'sistema.info') rodapeVersao(j.dados);
      }, function () {});
      return r;
    }, function () {
      marcarOnline(false);
      return cacheGet(k).then(function (c) {
        if (c && c.v) {
          var u = lerUsuario(corpo.acao, c.v.dados);
          if (u) definirUsuario(u, true);
          if (corpo.acao === 'sistema.info') rodapeVersao(c.v.dados);
          return resposta(c.v);
        }
        return resposta({ ok: false, codigo: 'OFFLINE', erro: 'Sem internet: esta informação ainda não foi carregada neste aparelho.' });
      });
    });
  }

  function enviarOuGuardar(input, init, corpo) {
    if (navigator.onLine === false) return guardar(corpo);
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;
    var opts = {};
    for (var p in init) if (Object.prototype.hasOwnProperty.call(init, p)) opts[p] = init[p];
    if (ctrl) opts.signal = ctrl.signal;
    return fetchOriginal(input, opts).then(function (r) { clearTimeout(t); marcarOnline(true); return r; },
      function () { clearTimeout(t); marcarOnline(false); return guardar(corpo); });
  }

  function guardar(corpo) {
    var dados = corpo.dados || {};
    if (corpo.acao === 'despesas.lancar' && !dados.chave) dados.chave = uid();
    var item = { id: uid(), acao: corpo.acao, dados: dados, usuarioId: usuarioAtual ? usuarioAtual.id : '', usuarioNome: usuarioAtual ? usuarioAtual.nome : '',
      criadoEm: Date.now(), situacao: 'aguardando', erro: '', codigo: '' };
    return filaPut(item).then(function () {
      atualizarAviso();
      return resposta({ ok: true, dados: { offline: true, id: 'Aguardando envio', status: 'Aguardando envio', extras: 0, excedente: 0 } });
    }, function () {
      return resposta({ ok: false, codigo: 'OFFLINE', erro: 'Sem internet e não foi possível salvar no celular. Tente de novo.' });
    });
  }

  /* ---------- Envio da fila ---------- */
  function sincronizar(forcar) {
    var api = window.DCV_API_URL;
    if (enviando || !api || navigator.onLine === false) return Promise.resolve();
    enviando = true;
    var enviados = 0;
    return filaTodos().then(function (lista) {
      var cadeia = Promise.resolve(), parar = false;
      lista.forEach(function (item) {
        cadeia = cadeia.then(function () {
          if (parar) return;
          if (item.situacao === 'erro' && !forcar) return;
          if (!usuarioAtual || item.usuarioId !== usuarioAtual.id) return;
          var token = tokenAtual();
          if (!token) { parar = true; return; }
          return fetchOriginal(api, { method: 'POST', credentials: 'omit', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ acao: item.acao, token: token, dados: item.dados }) })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (j) {
              marcarOnline(true);
              if (j.ok || j.codigo === 'DUPLICADO') { enviados++; return filaDel(item.id); }
              if (j.codigo === 'SESSAO_EXPIRADA' || j.codigo === 'ACESSO_INATIVO' || j.codigo === 'TROCAR_SENHA') { sessaoExpirada = true; parar = true; return; }
              item.situacao = 'erro'; item.erro = j.erro || 'Não foi possível enviar.'; item.codigo = j.codigo || '';
              return filaPut(item);
            }, function () { parar = true; marcarOnline(false); });
        });
      });
      return cadeia;
    }).then(fim, fim);
    function fim() {
      enviando = false;
      if (enviados) toast(enviados + ' lançamento(s) salvo(s) no celular foram enviados ao sistema.', 'ok');
      atualizarAviso();
      if (document.getElementById('dcv-off-modal')) abrirFila();
    }
  }

  /* ---------- Aviso e tela da fila ---------- */
  var aviso = null;
  function estilos() {
    var s = document.createElement('style');
    s.textContent = '.dcv-off-aviso{position:fixed;left:12px;bottom:84px;z-index:9998;border:0;border-radius:999px;padding:10px 14px;font:600 13px/1.2 system-ui,sans-serif;' +
      'background:#0B4F6C;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;max-width:calc(100% - 24px)}' +
      '.dcv-off-aviso.off{background:#8A5A00}.dcv-off-aviso.erro{background:#B42318}' +
      '#dcv-off-modal{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}' +
      '#dcv-off-modal .caixa{background:#fff;width:100%;max-width:560px;max-height:85vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px;font:14px/1.4 system-ui,sans-serif;color:#1d2b36}' +
      '#dcv-off-modal h3{margin:0 0 6px;color:#0B4F6C}#dcv-off-modal .it{border:1px solid #d5dde3;border-radius:10px;padding:10px;margin:8px 0}' +
      '#dcv-off-modal .sub{font-size:12px;color:#5b6b78}#dcv-off-modal .err{color:#B42318;font-size:13px;margin-top:4px}' +
      '#dcv-off-modal button{border:1px solid #c3ced6;background:#fff;border-radius:8px;padding:8px 12px;margin:6px 6px 0 0;font:600 13px system-ui,sans-serif;cursor:pointer}' +
      '#dcv-off-modal button.pri{background:#0B4F6C;color:#fff;border-color:#0B4F6C}';
    document.head.appendChild(s);
  }
  function descricao(item) {
    var d = item.dados || {};
    if (item.acao === 'despesas.lancar') return (d.estabelecimento || 'Despesa') + ' · ' + moeda(d.valorTotal) + (d.dataHora ? ' · ' + String(d.dataHora).replace('T', ' ') : '');
    if (item.acao === 'rh.heSolicitar') return (d.data || '') + ' · ' + (d.entrada || '') + ' às ' + (d.saida || '') + (d.descricao ? ' · ' + d.descricao : '');
    return item.acao;
  }
  function atualizarAviso() {
    if (!document.body) return;
    filaTodos().then(function (l) {
      if (!aviso) {
        aviso = document.createElement('button');
        aviso.type = 'button';
        aviso.onclick = abrirFila;
        document.body.appendChild(aviso);
      }
      var erros = l.filter(function (i) { return i.situacao === 'erro'; }).length;
      var semRede = navigator.onLine === false || !online;
      if (!l.length && !semRede) { aviso.style.display = 'none'; return; }
      aviso.style.display = '';
      aviso.className = 'dcv-off-aviso' + (erros ? ' erro' : semRede ? ' off' : '');
      aviso.textContent = (semRede ? 'Sem internet' : 'Conectado') +
        (l.length ? ' · ' + l.length + ' aguardando envio' + (erros ? ' (' + erros + ' com erro)' : '') : ' · lançamentos ficam salvos no celular');
    });
  }
  function fecharFila() { var m = document.getElementById('dcv-off-modal'); if (m) m.remove(); }
  function abrirFila() {
    filaTodos().then(function (l) {
      fecharFila();
      var m = document.createElement('div');
      m.id = 'dcv-off-modal';
      var semRede = navigator.onLine === false || !online;
      var h = '<div class="caixa"><h3>Lançamentos salvos no celular</h3><div class="sub">' +
        (semRede ? 'Sem internet agora. Eles serão enviados sozinhos quando a conexão voltar.' : 'Com internet: os lançamentos são enviados automaticamente.') +
        (sessaoExpirada ? '<br><strong>Sua sessão expirou: saia e entre novamente para enviar.</strong>' : '') + '</div>';
      if (!l.length) h += '<p>Nenhum lançamento aguardando envio.</p>';
      l.forEach(function (i) {
        var outro = !usuarioAtual || i.usuarioId !== usuarioAtual.id;
        h += '<div class="it"><strong>' + esc(FILA[i.acao] || i.acao) + '</strong> · ' + esc(descricao(i)) +
          '<div class="sub">Salvo em ' + esc(new Date(i.criadoEm).toLocaleString('pt-BR')) + (i.usuarioNome ? ' · ' + esc(i.usuarioNome) : '') + '</div>' +
          (outro ? '<div class="err">Lançado por outro usuário neste aparelho: entre com a conta ' + esc(i.usuarioNome || 'dele') + ' para enviar.</div>' : '') +
          (i.situacao === 'erro' ? '<div class="err">Não foi aceito pelo sistema: ' + esc(i.erro) + '</div>' : '') +
          (i.situacao === 'erro' && i.codigo === 'DIVERGENCIA' ? '<button type="button" data-off="divergencia" data-id="' + esc(i.id) + '">Enviar com a divergência registrada</button>' : '') +
          (i.situacao === 'erro' ? '<button type="button" data-off="tentar" data-id="' + esc(i.id) + '">Tentar de novo</button>' : '') +
          '<button type="button" data-off="descartar" data-id="' + esc(i.id) + '">Descartar</button></div>';
      });
      h += '<button type="button" class="pri" data-off="enviar">Enviar agora</button><button type="button" data-off="fechar">Fechar</button></div>';
      m.innerHTML = h;
      m.onclick = function (ev) {
        if (ev.target === m) return fecharFila();
        var b = ev.target.closest ? ev.target.closest('[data-off]') : null;
        if (!b) return;
        var acao = b.getAttribute('data-off'), id = b.getAttribute('data-id');
        var item = l.filter(function (x) { return x.id === id; })[0];
        if (acao === 'fechar') return fecharFila();
        if (acao === 'enviar') { b.textContent = 'Enviando…'; return sincronizar(true); }
        if (acao === 'descartar') {
          if (!window.confirm('Descartar este lançamento? Ele não será enviado ao sistema.')) return;
          return filaDel(id).then(function () { atualizarAviso(); abrirFila(); });
        }
        if (item && (acao === 'tentar' || acao === 'divergencia')) {
          if (acao === 'divergencia') item.dados.confirmarDivergencia = true;
          item.situacao = 'aguardando'; item.erro = ''; item.codigo = '';
          return filaPut(item).then(function () { return sincronizar(true); });
        }
      };
      document.body.appendChild(m);
    });
  }

  /* ---------- Início ---------- */
  function iniciar() {
    estilos();
    cacheGet('usuario').then(function (c) { if (c && c.v && !usuarioAtual) usuarioAtual = c.v; atualizarAviso(); });
    window.addEventListener('online', function () { marcarOnline(true); sincronizar(); });
    window.addEventListener('offline', function () { marcarOnline(false); });
    setTimeout(sincronizar, 5000);
    setInterval(function () { if (navigator.onLine !== false) sincronizar(); }, 60000);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').then(null, function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();

  window.DCV_OFFLINE = { fila: filaTodos, sincronizar: sincronizar, descartar: filaDel, abrir: abrirFila };
})();
