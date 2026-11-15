(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var email = $('account-email');
  var password = $('account-password');
  var msg = $('account-message');
  var login = $('login-button');
  var signup = $('signup-button');
  var sync = $('sync-status');
  var retry = $('retry-save');

  var client;
  var userId;
  var started = false;
  var pending = null;
  var timer = null;
  var running = null;
  var busy = false;

  function message(text, isError) {
    msg.textContent = text;
    msg.classList.toggle('error', !!isError);
  }

  function status(text, isError) {
    sync.textContent = text;
    sync.classList.toggle('error', !!isError);
    retry.hidden = !isError;
  }

  function accountBusy(value) {
    busy = value;
    login.disabled = value;
    signup.disabled = value;
  }

  function friendly(error) {
    var m = (
      (error && error.message) || ''
    ).toLowerCase();

    if (m.indexOf('invalid login') !== -1) {
      return 'Adresse e-mail ou mot de passe incorrect.';
    }

    if (m.indexOf('email not confirmed') !== -1) {
      return 'Confirmez d’abord votre adresse e-mail grâce au message reçu.';
    }

    if (
      m.indexOf('already registered') !== -1 ||
      m.indexOf('already been registered') !== -1
    ) {
      return 'Ce compte existe déjà. Essayez de vous connecter.';
    }

    if (m.indexOf('rate limit') !== -1) {
      return 'Trop de tentatives. Patientez avant de réessayer.';
    }

    return 'Une erreur est survenue. Vérifiez votre connexion et les réglages Supabase, puis réessayez.';
  }

  function queueSave(data) {
    pending = JSON.parse(JSON.stringify(data));

    status('Modification en attente…', false);

    clearTimeout(timer);
    timer = setTimeout(flush, 600);
  }

  async function flush() {
    clearTimeout(timer);

    if (running) {
      await running;

      if (pending) {
        return flush();
      }

      return true;
    }

    if (!pending) {
      return true;
    }

    running = (async function () {
      while (pending) {
        var snapshot = pending;
        pending = null;

        status('Enregistrement…', false);

        var error;

        try {
          var result = await client
            .from('mon_book_workspaces')
            .upsert(
              {
                user_id: userId,
                data: snapshot,
                updated_at: new Date().toISOString()
              },
              {
                onConflict: 'user_id'
              }
            );

          error = result.error;
        } catch (e) {
          error = e;
        }

        if (error) {
          if (!pending) {
            pending = snapshot;
          }

          status(
            'Non enregistré. Vérifiez votre connexion.',
            true
          );

          console.error(
            'Erreur de sauvegarde Mon Book:',
            error
          );

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

  retry.addEventListener('click', function () {
    flush();
  });

  window.addEventListener('beforeunload', function (event) {
    if (pending || running) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  window.addEventListener('online', function () {
    if (pending) {
      flush();
    }
  });

  async function openBook(user) {
    if (started) {
      return;
    }

    userId = user.id;
    message('Chargement de votre espace…');

    var result;

    try {
      result = await client
        .from('mon_book_workspaces')
        .select('data')
        .eq('user_id', userId)
        .maybeSingle();
    } catch (error) {
      result = { error: error };
    }

    if (result.error) {
      console.error(
        'Erreur de lecture Mon Book:',
        result.error
      );

      message(
        'Impossible de charger votre espace. Vérifiez que le code SQL a été exécuté dans Supabase et que votre connexion fonctionne.',
        true
      );

      accountBusy(false);
      return;
    }

    try {
      startBook(
        result.data ? result.data.data : {},
        queueSave
      );

      started = true;

      $('account-email-label').textContent =
        user.email || 'Mon compte';

      $('account-screen').hidden = true;
      $('book-app').hidden = false;

      status('Espace chargé', false);
    } catch (error) {
      console.error(error);

      message(
        'Impossible d’ouvrir le carnet. Aucune donnée n’a été supprimée.',
        true
      );

      accountBusy(false);
    }
  }

  $('account-form').addEventListener(
    'submit',
    async function (event) {
      event.preventDefault();

      if (busy || !client) {
        return;
      }

      accountBusy(true);
      message('Connexion…');

      try {
        var res = await client.auth.signInWithPassword({
          email: email.value.trim(),
          password: password.value
        });

        if (res.error) {
          message(friendly(res.error), true);
          accountBusy(false);
          return;
        }

        await openBook(res.data.user);
      } catch (error) {
        message(friendly(error), true);
        accountBusy(false);
      }
    }
  );

  signup.addEventListener('click', async function () {
    if (busy || !client) {
      return;
    }

    if (!$('account-form').reportValidity()) {
      return;
    }

    accountBusy(true);
    message('Création du compte…');

    try {
      var res = await client.auth.signUp({
        email: email.value.trim(),
        password: password.value
      });

      if (res.error) {
        message(friendly(res.error), true);
        accountBusy(false);
        return;
      }

      if (res.data.session && res.data.user) {
        await openBook(res.data.user);
      } else {
        password.value = '';

        message(
          'Vérifiez votre boîte e-mail et confirmez votre adresse, puis revenez vous connecter. Pensez aussi à vérifier les courriers indésirables.'
        );

        accountBusy(false);
      }
    } catch (error) {
      message(friendly(error), true);
      accountBusy(false);
    }
  });

  $('logout-button').addEventListener(
    'click',
    async function () {
      var button = $('logout-button');
      button.disabled = true;

      if (!(await flush())) {
        button.disabled = false;
        return;
      }

      var result = await client.auth.signOut();

      if (result.error) {
        status(
          'Déconnexion impossible. Réessayez.',
          true
        );

        button.disabled = false;
        return;
      }

      location.reload();
    }
  );

  async function init() {
    accountBusy(true);

    var config = window.MON_BOOK_CONFIG;

    if (
      !config ||
      !/^https:\/\//.test(config.supabaseUrl || '') ||
      !config.supabaseKey ||
      config.supabaseKey.indexOf('VOTRE_') === 0
    ) {
      message(
        'Configuration nécessaire : renseignez l’URL et la clé publique Supabase dans le fichier config.js.',
        true
      );

      return;
    }

    if (
      !window.supabase ||
      !window.supabase.createClient
    ) {
      message(
        'Impossible de charger le service de connexion. Vérifiez votre connexion Internet et actualisez la page.',
        true
      );

      return;
    }

    try {
      client = window.supabase.createClient(
        config.supabaseUrl,
        config.supabaseKey
      );

      var response = await client.auth.getUser();

      if (response.data && response.data.user) {
        await openBook(response.data.user);
        return;
      }

      message('Connectez-vous ou créez votre compte.');
      accountBusy(false);
    } catch (error) {
      message(friendly(error), true);
      accountBusy(false);
    }
  }

  init();
})();
