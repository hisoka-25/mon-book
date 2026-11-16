(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var client, currentUser, started = false, busy = false, mode = 'login';
  var pending = null, running = null, timer = null;
  var email = $('account-email'), password = $('account-password');
  var messageNode = $('account-message'), gateMessage = $('gate-message');
  var sync = $('sync-status'), retry = $('retry-save');

  function message(node, text, isError) {
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }
  function status(text, isError) {
    sync.textContent = text;
    sync.classList.toggle('error', !!isError);
    retry.hidden = !isError;
  }
  function lock(value) {
    busy = value;
    ['auth-submit', 'auth-switch', 'send-code', 'check-payment', 'open-code', 'verify-code', 'resend-code', 'gate-logout'].forEach(function (id) { $(id).disabled = value; });
  }
  function setMode(next) {
    mode = next;
    $('auth-heading').textContent = mode === 'signup' ? 'Bienvenue dans votre espace' : 'Ravi de vous retrouver';
    $('auth-description').textContent = mode === 'signup' ? 'Créez votre compte pour organiser vos idées.' : 'Connectez-vous à votre espace personnel.';
    $('auth-submit').textContent = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
    $('auth-switch-label').textContent = mode === 'signup' ? 'Vous avez déjà un compte ? ' : 'Pas encore de compte ? ';
    $('auth-switch').textContent = mode === 'signup' ? 'Se connecter' : 'Créer mon compte';
    password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('password-help').hidden = mode !== 'signup';
    message(messageNode, '');
  }
  function friendly(error) {
    var m = ((error && error.message) || '').toLowerCase();
    if (m.indexOf('invalid login') !== -1) return 'Adresse e-mail ou mot de passe incorrect.';
    if (m.indexOf('email not confirmed') !== -1) return 'Confirmez d’abord votre adresse e-mail grâce au message reçu.';
    if (m.indexOf('already registered') !== -1 || m.indexOf('already been registered') !== -1) return 'Ce compte existe déjà. Essayez de vous connecter.';
    if (m.indexOf('rate limit') !== -1) return 'Trop de tentatives. Patientez avant de réessayer.';
    return 'Une erreur est survenue. Vérifiez votre connexion et réessayez.';
  }
  function queueSave(data) {
    pending = JSON.parse(JSON.stringify(data));
    status('Modification en attente…', false);
    clearTimeout(timer);
    timer = setTimeout(flush, 600);
  }
  async function flush() {
    clearTimeout(timer);
    if (running) { var ongoing = await running; if (!ongoing) return false; if (pending) return flush(); return true; }
    if (!pending) return true;
    running = (async function () {
      while (pending) {
        var snapshot = pending;
        pending = null;
        status('Enregistrement…', false);
        var error;
        try {
          var result = await client.from('mon_book_workspaces').upsert({ user_id: currentUser.id, data: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
          error = result.error;
        } catch (e) { error = e; }
        if (error) {
          if (!pending) pending = snapshot;
          status('Non enregistré. Vérifiez votre connexion.', true);
          return false;
        }
      }
      status('Enregistré', false);
      return true;
    })();
    var success = await running;
    running = null;
    return success;
  }
  retry.addEventListener('click', function () { flush(); });
  window.addEventListener('beforeunload', function (event) { if (pending || running) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('online', function () { if (pending) flush(); });

  async function openBook() {
    if (started) return;
    var result;
    try { result = await client.from('mon_book_workspaces').select('data').eq('user_id', currentUser.id).maybeSingle(); }
    catch (error) { result = { error: error }; }
    if (result.error) {
      message(gateMessage, 'Impossible de charger votre espace. Vérifiez votre connexion et réessayez.', true);
      lock(false); return;
    }
    try {
      startBook(result.data ? result.data.data : {}, queueSave);
      started = true;
      $('account-email-label').textContent = currentUser.email || 'Mon compte';
      $('account-screen').hidden = true;
      $('gate-screen').hidden = true;
      $('book-app').hidden = false;
      status('Espace chargé', false);
    } catch (error) {
      message(gateMessage, 'Impossible d’ouvrir le carnet. Aucune donnée n’a été supprimée.', true);
      lock(false);
    }
  }
  async function enter(user) {
    currentUser = user;
    $('account-screen').hidden = true;
    $('gate-screen').hidden = false;
    $('gate-payment').hidden = true;
    $('gate-code').hidden = true;
    message(gateMessage, 'Vérification de votre accès…');
    var result;
    try { result = await client.from('mon_book_access').select('user_id').eq('user_id', user.id).maybeSingle(); }
    catch (error) { result = { error: error }; }
    if (result.error) {
      message(gateMessage, 'Impossible de vérifier votre accès. Déconnectez-vous et réessayez.', true);
      lock(false); return;
    }
    if (result.data) { await openBook(); return; }
    $('gate-payment').hidden = false;
    message(gateMessage, '');
    lock(false);
    if (new URLSearchParams(location.search).has('paiement')) await checkPayment();
  }
  async function activation(action, code) {
    var result = await client.auth.getSession();
    var session = result.data && result.data.session;
    if (!session || !session.access_token) throw new Error('Votre session a expiré. Reconnectez-vous.');
    var response = await fetch('/api/activation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ action: action, code: code || '' })
    });
    var data;
    try { data = await response.json(); } catch (error) { throw new Error('Service indisponible. Réessayez.'); }
    if (!response.ok) throw new Error(data.message || 'Service indisponible. Réessayez.');
    return data;
  }
  async function payment(action) {
    var result = await client.auth.getSession();
    var session = result.data && result.data.session;
    if (!session || !session.access_token) throw new Error('Votre session a expiré. Reconnectez-vous.');
    var response = await fetch('/api/paiement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ action: action })
    });
    var data;
    try { data = await response.json(); } catch (error) { throw new Error('Service indisponible. Réessayez.'); }
    if (!response.ok) throw new Error(data.message || 'Service indisponible. Réessayez.');
    return data;
  }
  async function checkPayment() {
    if (busy) return;
    lock(true); message(gateMessage, 'Vérification du paiement…');
    try {
      var data = await payment('status');
      if (data.status === 'paid') {
        lock(false);
        await sendCode();
        return;
      }
      if (data.status === 'pending') message(gateMessage, 'Paiement en attente de confirmation. Si vous avez déjà payé, ne payez pas deux fois : patientez puis vérifiez à nouveau.');
      else message(gateMessage, 'Aucun paiement confirmé pour ce compte.');
    } catch (error) { message(gateMessage, error.message || 'Vérification impossible.', true); }
    lock(false);
  }
  async function startPayment() {
    if (busy) return;
    lock(true); message(gateMessage, 'Préparation du paiement Wave…');
    try {
      var data = await payment('start');
      if (data.status === 'paid') {
        lock(false);
        await sendCode();
        return;
      }
      if (data.redirectUrl) {
        var url = new URL(data.redirectUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'pay.jeko.africa' || url.username || url.password) throw new Error('Adresse de paiement invalide.');
        message(gateMessage, 'Redirection vers Wave…');
        location.assign(url.href);
        return;
      }
      message(gateMessage, 'Paiement en attente. Si vous avez déjà payé, ne payez pas deux fois.');
    } catch (error) { message(gateMessage, error.message || 'Paiement indisponible.', true); }
    lock(false);
  }
  async function sendCode() {
    if (busy) return;
    lock(true); message(gateMessage, 'Envoi du code…');
    try {
      var data = await activation('send');
      if (data.active) { await openBook(); return; }
      $('gate-payment').hidden = true;
      $('gate-code').hidden = false;
      message(gateMessage, data.message);
      $('activation-code').focus();
    } catch (error) { message(gateMessage, error.message || 'Envoi impossible. Réessayez.', true); }
    lock(false);
  }
  $('auth-switch').addEventListener('click', function () { if (!busy) setMode(mode === 'login' ? 'signup' : 'login'); });
  $('account-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !client) return;
    lock(true); message(messageNode, mode === 'signup' ? 'Création du compte…' : 'Connexion…');
    try {
      var details = { email: email.value.trim(), password: password.value };
      var res = mode === 'signup' ? await client.auth.signUp(details) : await client.auth.signInWithPassword(details);
      if (res.error) { message(messageNode, friendly(res.error), true); lock(false); return; }
      if (res.data.session && res.data.user) { await enter(res.data.user); return; }
      password.value = '';
      setMode('login');
      message(messageNode, 'Vérifiez votre boîte e-mail et confirmez votre adresse, puis revenez vous connecter. Pensez à vérifier les courriers indésirables.');
      lock(false);
    } catch (error) { message(messageNode, friendly(error), true); lock(false); }
  });
  $('send-code').addEventListener('click', startPayment);
  $('check-payment').addEventListener('click', checkPayment);
  $('resend-code').addEventListener('click', sendCode);
  $('open-code').addEventListener('click', function () {
    $('gate-payment').hidden = true;
    $('gate-code').hidden = false;
    message(gateMessage, '');
    $('activation-code').focus();
  });
  $('code-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    lock(true); message(gateMessage, 'Vérification du code…');
    try {
      await activation('verify', $('activation-code').value.trim());
      await openBook();
      if (!started) lock(false);
    } catch (error) { message(gateMessage, error.message || 'Vérification impossible.', true); lock(false); }
  });
  async function logout(button) {
    button.disabled = true;
    if (!(await flush())) { button.disabled = false; return; }
    try {
      var result = await client.auth.signOut();
      if (result.error) throw result.error;
      location.reload();
    } catch (error) {
      button.disabled = false;
      if (!$('gate-screen').hidden) message(gateMessage, 'Déconnexion impossible. Réessayez.', true);
      else status('Déconnexion impossible. Réessayez.', true);
    }
  }
  $('logout-button').addEventListener('click', function () { logout($('logout-button')); });
  $('gate-logout').addEventListener('click', function () { logout($('gate-logout')); });
  async function init() {
    lock(true);
    var config = window.MON_BOOK_CONFIG;
    if (!config || !/^https:\/\//.test(config.supabaseUrl || '') || !config.supabaseKey || config.supabaseKey.indexOf('VOTRE_') === 0) {
      message(messageNode, 'Configuration Supabase manquante.', true); return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      message(messageNode, 'Impossible de charger la connexion. Vérifiez Internet et actualisez.', true); return;
    }
    try {
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
      var response = await client.auth.getUser();
      if (response.data && response.data.user) { await enter(response.data.user); return; }
      setMode('login'); lock(false);
    } catch (error) { message(messageNode, friendly(error), true); lock(false); }
  }
  init();
})();
