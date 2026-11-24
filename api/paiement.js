const crypto = require('node:crypto');

const SUPABASE_URL =
  'https://swgifqnatsxekmimrges.supabase.co';

const SUPABASE_PUBLIC_KEY =
  'sb_publishable_uyLf-VUBkm18v35ArYs4nQ_78F8PSr-';

const ORIGIN = 'https://mon-book.vercel.app';

const AMOUNT = 110000;
const SUPPORTED_AMOUNTS = new Set([110000, 210000]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const dbKey = process.env.SUPABASE_SECRET_KEY;
  const apiKey = process.env.JEKO_API_KEY;
  const apiKeyId = process.env.JEKO_API_KEY_ID;
  const storeId = process.env.JEKO_STORE_ID;

  const webhookSecret =
    process.env.JEKO_WEBHOOK_SECRET;

  const resendKey = process.env.RESEND_API_KEY;

  const testEmail = (
    process.env.MONBOOK_TEST_EMAIL || ''
  ).trim().toLowerCase();

  const publicSales =
    process.env.MONBOOK_PUBLIC_SALES === 'true';

  if (
    !dbKey ||
    !apiKey ||
    !apiKeyId ||
    !UUID.test(storeId || '') ||
    !webhookSecret ||
    !resendKey ||
    (!testEmail && !publicSales)
  ) {
    return reply(
      503,
      'Le paiement n’est pas encore configuré.'
    );
  }

  const auth = req.headers.authorization || '';

  if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth)) {
    return reply(
      401,
      'Connectez-vous avant de continuer.'
    );
  }

  const body = req.body;

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !['start', 'status'].includes(body.action)
  ) {
    return reply(400, 'Demande invalide.');
  }

  try {
    const userResponse = await fetch(
      SUPABASE_URL + '/auth/v1/user',
      {
        headers: {
          apikey: SUPABASE_PUBLIC_KEY,
          Authorization: auth
        },
        signal: AbortSignal.timeout(8000)
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

    if (
      !UUID.test(user.id || '') ||
      !user.email_confirmed_at ||
      !email ||
      (!publicSales && email !== testEmail)
    ) {
      return reply(
        403,
        publicSales
          ? 'Un compte confirmé est nécessaire pour payer.'
          : 'Le paiement est réservé au compte de test autorisé.'
      );
    }

    async function db(path, options = {}) {
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/' + path,
        {
          ...options,
          headers: {
            apikey: dbKey,
            'Content-Type': 'application/json',
            ...(options.headers || {})
          },
          signal: AbortSignal.timeout(8000)
        }
      );

      if (!response.ok) {
        throw new Error('db_error');
      }

      return response.json();
    }

    function safeUrl(value) {
      try {
        const url = new URL(value);

        if (
          url.protocol === 'https:' &&
          url.hostname === 'pay.jeko.africa' &&
          !url.username &&
          !url.password
        ) {
          return url.href;
        }

        return null;
      } catch (error) {
        return null;
      }
    }

    async function currentPayment() {
      const rows = await db(
        'mon_book_payments?user_id=eq.' +
        user.id +
        '&status=in.(creating,pending)' +
        '&select=id,reference,status,payment_request_id,provider_transaction_id,amount_cents,currency,redirect_url'
      );

      if (!Array.isArray(rows) || rows.length > 1) {
        throw new Error('db_error');
      }

      return rows[0] || null;
    }

    async function currentSubscription() {
      const rows = await db(
        'mon_book_subscriptions?user_id=eq.' +
        user.id +
        '&select=user_id,anchor_day,expires_at,is_lifetime,last_payment_id'
      );
      if (!Array.isArray(rows) || rows.length > 1) {
        throw new Error('db_error');
      }
      return rows[0] || null;
    }

    function subscriptionIsActive(subscription) {
      if (!subscription) return false;
      if (subscription.is_lifetime === true) return true;
      const expiry = Date.parse(subscription.expires_at || '');
      return Number.isFinite(expiry) && expiry > Date.now();
    }

    function formatExpiry(subscription) {
      const date = new Date(subscription && subscription.expires_at || '');
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', {
        timeZone: 'Africa/Abidjan', day: 'numeric', month: 'long', year: 'numeric'
      });
    }

    async function markPaid(payment, request) {
      const transaction =
        request && request.transaction;
      const expectedAmount = payment && payment.amount_cents;

      if (
        !Number.isSafeInteger(expectedAmount) ||
        !SUPPORTED_AMOUNTS.has(expectedAmount) ||
        !request ||
        request.id !== payment.payment_request_id ||
        request.storeId !== storeId ||
        request.reference !== payment.reference ||
        request.status !== 'success' ||
        !transaction ||
        typeof transaction.id !== 'string' ||
        !transaction.id ||
        transaction.id.length > 200 ||
        transaction.status !== 'success' ||
        !transaction.amount ||
        transaction.amount.amount !== expectedAmount ||
        transaction.amount.currency !== 'XOF' ||
        payment.currency !== 'XOF'
      ) {
        return false;
      }

      const result = await db(
        'rpc/mon_book_apply_subscription_payment',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            p_payment_id: payment.id,
            p_transaction_id: transaction.id
          })
        }
      );

      return result === 'applied' || result === 'already_applied';
    }

    async function reconcile(payment) {
      if (
        !payment ||
        payment.status !== 'pending' ||
        !UUID.test(payment.payment_request_id || '')
      ) {
        return payment;
      }

      const response = await fetch(
        'https://api.jeko.africa/partner_api/payment_requests/' +
        payment.payment_request_id,
        {
          headers: {
            'X-API-KEY': apiKey,
            'X-API-KEY-ID': apiKeyId
          },
          signal: AbortSignal.timeout(8000)
        }
      );

      if (!response.ok) {
        return payment;
      }

      const request = await response.json();

      if (
        !request ||
        request.id !== payment.payment_request_id ||
        request.reference !== payment.reference ||
        request.storeId !== storeId
      ) {
        return payment;
      }

      if (request.status === 'success') {
        if (await markPaid(payment, request)) {
          return await currentPayment();
        }
      } else if (request.status === 'error') {
        const updated = await db(
          'mon_book_payments?id=eq.' +
          payment.id +
          '&status=eq.pending&select=id',
          {
            method: 'PATCH',
            headers: {
              Prefer: 'return=representation'
            },
            body: JSON.stringify({
              status: 'failed',
              updated_at: new Date().toISOString()
            })
          }
        );

        if (
          Array.isArray(updated) &&
          updated.length === 1
        ) {
          return null;
        }

        return await currentPayment();
      }

      return payment;
    }

    let payment = await currentPayment();

    if (body.action === 'status') {
      if (
        payment &&
        payment.status === 'pending'
      ) {
        payment = await reconcile(payment);
      }

      if (payment && payment.status === 'pending') {
        const pendingMessage = payment.amount_cents === AMOUNT
          ? 'Votre paiement unique de 1 100 FCFA est en attente de confirmation.'
          : 'Une ancienne demande de paiement de ' + (payment.amount_cents === 210000 ? '2 100' : '1 100') + ' FCFA est encore en cours. Ne payez pas une seconde fois ; vérifiez d’abord son statut.';
        return reply(200, pendingMessage, {
          status: 'pending',
          amountCents: payment.amount_cents
        });
      }

      if (payment) {
        return reply(200, 'Une demande de paiement est en cours de préparation. Ne relancez pas le paiement.', { status: 'pending' });
      }

      const subscription = await currentSubscription();
      if (subscriptionIsActive(subscription)) {
        if (subscription.is_lifetime === true) {
          return reply(200, 'Votre accès à vie est déjà actif.', {
            status: 'paid',
            lifetime: true
          });
        }
        return reply(200, 'Votre accès est actif jusqu’au ' + formatExpiry(subscription) + '.', {
          status: 'paid',
          lifetime: false,
          expiresAt: subscription.expires_at
        });
      }
      if (subscription) {
        return reply(200, 'Votre accès a expiré le ' + formatExpiry(subscription) + '. Un paiement unique de 1 100 FCFA le réactive à vie.', {
          status: 'expired',
          expiresAt: subscription.expires_at
        });
      }
      return reply(200, 'Aucun paiement confirmé pour ce compte.', { status: 'not_started' });
    }

    if (process.env.JEKO_LIVE_ENABLED !== 'true') {
      return reply(
        503,
        'Les paiements réels ne sont pas encore activés.'
      );
    }

    if (
      payment &&
      payment.status === 'pending'
    ) {
      payment = await reconcile(payment);
    }

    if (payment && payment.status === 'paid') {
      return reply(
        200,
        'Paiement confirmé.',
        { status: 'paid' }
      );
    }

    if (payment && payment.status === 'pending') {
      if (!SUPPORTED_AMOUNTS.has(payment.amount_cents)) {
        return reply(409, 'Une ancienne demande doit être vérifiée. Ne payez pas et contactez le support.');
      }
      if (payment.amount_cents !== AMOUNT) {
        return reply(409, 'Une demande au tarif précédent de ' + (payment.amount_cents === 210000 ? '2 100' : '1 100') + ' FCFA est encore en cours. Ne payez pas ce lien ; vérifiez d’abord son statut.');
      }
      const url = safeUrl(payment.redirect_url);
      if (url) {
        return reply(200, 'Paiement en attente.', {
          status: 'pending',
          amountCents: payment.amount_cents,
          redirectUrl: url
        });
      }
      return reply(409, 'Un paiement est déjà en cours. Ne payez pas deux fois.');
    }

    if (payment) {
      return reply(409, 'Une demande de paiement est en cours de vérification. Ne payez pas deux fois.');
    }

    const subscription = await currentSubscription();
    if (subscriptionIsActive(subscription)) {
      if (subscription.is_lifetime === true) {
        return reply(200, 'Votre accès à vie est déjà actif.', {
          status: 'paid',
          lifetime: true
        });
      }
      return reply(200, 'Votre accès est actif jusqu’au ' + formatExpiry(subscription) + '.', {
        status: 'paid',
        lifetime: false,
        expiresAt: subscription.expires_at
      });
    }

    const reference =
      'MB-' + crypto.randomBytes(16).toString('hex');

    const created = await db(
      'mon_book_payments?select=id,reference,status',
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          user_id: user.id,
          reference: reference,
          amount_cents: AMOUNT,
          currency: 'XOF'
        })
      }
    );

    if (
      !Array.isArray(created) ||
      created.length !== 1 ||
      !UUID.test(created[0].id || '')
    ) {
      throw new Error('db_error');
    }

    const jekoResponse = await fetch(
      'https://api.jeko.africa/partner_api/payment_requests',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'X-API-KEY-ID': apiKeyId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          storeId: storeId,
          amountCents: AMOUNT,
          currency: 'XOF',
          reference: reference,
          paymentDetails: {
            type: 'redirect',
            data: {
              paymentMethod: 'wave',
              successUrl:
                ORIGIN + '/?paiement=retour',
              errorUrl:
                ORIGIN + '/?paiement=retour'
            }
          }
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!jekoResponse.ok) {
      return reply(
        503,
        'La demande doit être vérifiée. Ne relancez pas le paiement ; contactez le support.'
      );
    }

    const jeko = await jekoResponse.json();

    const redirect = safeUrl(
      jeko && jeko.redirectUrl
    );

    if (
      !jeko ||
      !UUID.test(jeko.id || '') ||
      jeko.storeId !== storeId ||
      jeko.reference !== reference ||
      jeko.status !== 'pending' ||
      !redirect
    ) {
      return reply(
        503,
        'La demande doit être vérifiée. Ne relancez pas le paiement ; contactez le support.'
      );
    }

    const saved = await db(
      'mon_book_payments?id=eq.' +
      created[0].id +
      '&status=eq.creating&select=id',
      {
        method: 'PATCH',
        headers: {
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          status: 'pending',
          payment_request_id: jeko.id,
          redirect_url: redirect,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (
      !Array.isArray(saved) ||
      saved.length !== 1
    ) {
      const current = await currentPayment();

      if (current && current.status === 'paid') {
        return reply(
          200,
          'Paiement confirmé.',
          { status: 'paid' }
        );
      }

      return reply(
        503,
        'La demande doit être vérifiée. Ne payez pas deux fois.'
      );
    }

    return reply(
      200,
      'Vous allez être redirigé vers le paiement Wave.',
      {
        status: 'pending',
        redirectUrl: redirect
      }
    );
  } catch (error) {
    return reply(
      503,
      'Service temporairement indisponible. Si vous avez commencé à payer, ne payez pas deux fois et contactez le support.'
    );
  }
};
