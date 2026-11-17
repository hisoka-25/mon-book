const crypto = require('node:crypto');

const SUPABASE_URL =
  'https://swgifqnatsxekmimrges.supabase.co';

const SUPPORTED_AMOUNTS = new Set([110000, 210000]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFERENCE = /^MB-[0-9a-f]{32}$/;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return res.status(405).json({
      message: 'Méthode non autorisée.'
    });
  }

  const webhookSecret =
    process.env.JEKO_WEBHOOK_SECRET;

  const apiKey = process.env.JEKO_API_KEY;
  const apiKeyId = process.env.JEKO_API_KEY_ID;
  const storeId = process.env.JEKO_STORE_ID;
  const dbKey = process.env.SUPABASE_SECRET_KEY;

  if (
    !webhookSecret ||
    !apiKey ||
    !apiKeyId ||
    !UUID.test(storeId || '') ||
    !dbKey
  ) {
    return res.status(503).json({
      message: 'Configuration incomplète.'
    });
  }

  try {
    let size = 0;
    const chunks = [];

    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      size += bytes.length;

      if (size > 1048576) {
        return res.status(413).end();
      }

      chunks.push(bytes);
    }

    const raw = Buffer.concat(chunks);
    const signature = req.headers['jeko-signature'];

    if (
      typeof signature !== 'string' ||
      !/^[0-9a-f]{64}$/.test(signature)
    ) {
      return res.status(401).json({
        message: 'Signature invalide.'
      });
    }

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(raw)
      .digest();

    const received = Buffer.from(signature, 'hex');

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.status(401).json({
        message: 'Signature invalide.'
      });
    }

    if (
      req.headers['jeko-event'] !==
      'TRANSACTION_COMPLETED'
    ) {
      return res.status(200).json({
        received: true
      });
    }

    let event;

    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return res.status(400).json({
        message: 'Données invalides.'
      });
    }

    const details = event && event.transactionDetails;
    const reference = details && details.reference;

    if (
      typeof reference !== 'string' ||
      !REFERENCE.test(reference)
    ) {
      return res.status(200).json({
        received: true
      });
    }

    if (
      event.transactionType !== 'payment' ||
      event.status !== 'success' ||
      event.storeId !== storeId ||
      !details ||
      !UUID.test(details.id || '') ||
      typeof event.id !== 'string' ||
      !event.id ||
      event.id.length > 200 ||
      !event.amount
    ) {
      return res.status(400).json({
        message: 'Transaction non conforme.'
      });
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

    const rows = await db(
      'mon_book_payments?reference=eq.' +
      reference +
      '&select=id,reference,status,payment_request_id,provider_transaction_id,amount_cents,currency'
    );

    if (!Array.isArray(rows) || rows.length !== 1) {
      return res.status(200).json({
        received: true
      });
    }

    const payment = rows[0];
    const expectedAmount = payment.amount_cents;

    if (
      !Number.isSafeInteger(expectedAmount) ||
      !SUPPORTED_AMOUNTS.has(expectedAmount) ||
      !event.amount ||
      event.amount.currency !== 'XOF' ||
      event.amount.amount !== expectedAmount ||
      payment.currency !== 'XOF'
    ) {
      return res.status(400).json({ message: 'Transaction non conforme.' });
    }

    if (payment.status === 'paid') {
      if (payment.provider_transaction_id !== event.id) {
        return res.status(409).json({
          message: 'Conflit de transaction.'
        });
      }

      return res.status(200).json({
        received: true
      });
    }

    if (
      !['creating', 'pending'].includes(payment.status) ||
      !SUPPORTED_AMOUNTS.has(payment.amount_cents) ||
      payment.currency !== 'XOF' ||
      (
        payment.payment_request_id &&
        payment.payment_request_id !== details.id
      )
    ) {
      return res.status(400).json({
        message: 'Paiement non conforme.'
      });
    }

    const check = await fetch(
      'https://api.jeko.africa/partner_api/payment_requests/' +
      details.id,
      {
        headers: {
          'X-API-KEY': apiKey,
          'X-API-KEY-ID': apiKeyId
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!check.ok) {
      return res.status(503).json({
        message: 'Vérification en attente.'
      });
    }

    const verified = await check.json();
    const transaction = verified && verified.transaction;

    if (
      !verified ||
      verified.id !== details.id ||
      verified.reference !== reference ||
      verified.storeId !== storeId ||
      verified.status !== 'success' ||
      !transaction ||
      transaction.id !== event.id ||
      transaction.status !== 'success' ||
      !transaction.amount ||
      transaction.amount.amount !== expectedAmount ||
      transaction.amount.currency !== 'XOF'
    ) {
      return res.status(503).json({
        message: 'Vérification en attente.'
      });
    }

    const result = await db(
      'rpc/mon_book_apply_subscription_payment',
      {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          p_payment_id: payment.id,
          p_transaction_id: event.id
        })
      }
    );

    if (result === 'applied' || result === 'already_applied') {
      return res.status(200).json({ received: true });
    }

    return res.status(503).json({ message: 'Enregistrement de l’abonnement en attente.' });
  } catch (error) {
    return res.status(503).json({
      message: 'Service temporairement indisponible.'
    });
  }
}

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: false
  }
};
