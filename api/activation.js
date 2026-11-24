const crypto = require('node:crypto');

const SUPABASE_URL =
  'https://swgifqnatsxekmimrges.supabase.co';

const SUPABASE_PUBLIC_KEY =
  'sb_publishable_uyLf-VUBkm18v35ArYs4nQ_78F8PSr-';

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  function reply(status, message, extra = {}) {
    return res.status(status).json({
      message,
      ...extra
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(405, 'Méthode non autorisée.');
  }

  const secret = process.env.SUPABASE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!secret || !resendKey) {
    return reply(
      503,
      'Le service n’est pas encore configuré.'
    );
  }

  const authorization =
    req.headers.authorization || '';

  if (
    !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
  ) {
    return reply(
      401,
      'Connectez-vous avant de continuer.'
    );
  }

  const body = req.body;

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return reply(400, 'Demande invalide.');
  }

  if (
    body.action !== 'send' &&
    body.action !== 'verify'
  ) {
    return reply(400, 'Action invalide.');
  }

  try {
    const userResponse = await fetch(
      SUPABASE_URL + '/auth/v1/user',
      {
        headers: {
          apikey: SUPABASE_PUBLIC_KEY,
          Authorization: authorization
        }
      }
    );

    if (!userResponse.ok) {
      return reply(
        401,
        'Votre session a expiré. Reconnectez-vous.'
      );
    }

    const user = await userResponse.json();

    const email = (
      user.email || ''
    ).trim().toLowerCase();

    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !uuid.test(user.id || '') ||
      !user.email_confirmed_at ||
      !email
    ) {
      return reply(
        403,
        'Un compte avec une adresse e-mail confirmée est nécessaire.'
      );
    }

    const subscriptionResponse = await fetch(
      SUPABASE_URL +
      '/rest/v1/mon_book_subscriptions?user_id=eq.' +
      user.id +
      '&select=expires_at,is_lifetime&limit=1',
      {
        headers: { apikey: secret },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!subscriptionResponse.ok) {
      return reply(503, 'Impossible de vérifier votre accès. Réessayez.');
    }

    const subscriptions = await subscriptionResponse.json();
    const subscription = Array.isArray(subscriptions) && subscriptions.length === 1
      ? subscriptions[0]
      : null;
    const lifetimeAccess = !!(subscription && subscription.is_lifetime === true);
    const activeUntil = subscription ? Date.parse(subscription.expires_at || '') : NaN;

    if (!lifetimeAccess && (!Number.isFinite(activeUntil) || activeUntil <= Date.now())) {
      return reply(402, 'Votre accès a expiré. Payez 1 100 FCFA une seule fois pour le réactiver à vie.');
    }

    const paymentResponse = await fetch(
      SUPABASE_URL +
      '/rest/v1/mon_book_payments?user_id=eq.' +
      user.id +
      '&status=eq.paid&select=id,paid_at&order=paid_at.desc&limit=1',
      {
        headers: {
          apikey: secret
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!paymentResponse.ok) {
      return reply(
        503,
        'Impossible de vérifier le paiement. Réessayez.'
      );
    }

    const payments = await paymentResponse.json();

    if (
      !Array.isArray(payments) ||
      payments.length !== 1 ||
      !payments[0].id
    ) {
      return reply(
        402,
        'Aucun paiement confirmé pour ce compte.'
      );
    }

    const paymentId = payments[0].id;

    async function rpc(name, payload) {
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/rpc/' + name,
        {
          method: 'POST',
          headers: {
            apikey: secret,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        throw new Error('database_error');
      }

      return response.json();
    }

    function hashCode(code) {
      return crypto
        .createHmac('sha256', secret)
        .update(
          user.id + ':' + paymentId + ':' + code
        )
        .digest('hex');
    }

    if (body.action === 'send') {
      const code = String(
        crypto.randomInt(0, 100000000)
      ).padStart(8, '0');

      const result = await rpc(
        'mon_book_issue_test_code',
        {
          p_user: user.id,
          p_hash: hashCode(code)
        }
      );

      if (result === 'already_active') {
        return reply(
          200,
          'Votre compte est déjà activé.',
          { active: true }
        );
      }

      if (result === 'wait') {
        return reply(
          429,
          'Patientez une minute avant de demander un autre code.'
        );
      }

      if (result === 'limit') {
        return reply(
          429,
          'Trop de demandes. Réessayez dans une heure.'
        );
      }

      if (result !== 'issued') {
        return reply(
          500,
          'Impossible de préparer le code.'
        );
      }

      const mail = await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + resendKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Mon Book <codes@monbook.goalxs.com>',
            to: [email],
            subject: 'Votre code d’activation Mon Book',
            text:
              'Bonjour,\n\n' +
              'Votre code d’activation Mon Book est : ' +
              code +
              '\n\n' +
              'Ce code est personnel, valable 15 minutes et utilisable une seule fois.\n\n' +
              'Votre paiement a été confirmé.\n\n' +
              'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.'
          })
        }
      );

      if (!mail.ok) {
        return reply(
          502,
          'L’envoi du code a échoué. Attendez une minute puis réessayez.'
        );
      }

      return reply(
        200,
        'Le code a été envoyé à votre adresse e-mail.'
      );
    }

    const code =
      typeof body.code === 'string'
        ? body.code.trim()
        : '';

    if (!/^\d{8}$/.test(code)) {
      return reply(
        400,
        'Le code doit contenir 8 chiffres.'
      );
    }

    const result = await rpc(
      'mon_book_redeem_test_code',
      {
        p_user: user.id,
        p_hash: hashCode(code)
      }
    );

    if (result === 'activated') {
      return reply(
        200,
        'Votre compte est activé.',
        { active: true }
      );
    }

    if (result === 'expired') {
      return reply(
        400,
        'Ce code a expiré. Demandez-en un nouveau.'
      );
    }

    if (result === 'used') {
      return reply(
        400,
        'Ce code a déjà été utilisé.'
      );
    }

    if (result === 'locked') {
      return reply(
        429,
        'Trop de tentatives. Demandez un nouveau code.'
      );
    }

    return reply(400, 'Code incorrect.');
  } catch (error) {
    return reply(
      503,
      'Le service est temporairement indisponible. Réessayez.'
    );
  }
};
