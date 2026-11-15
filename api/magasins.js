const SUPABASE_URL =
  'https://swgifqnatsxekmimrges.supabase.co';

const SUPABASE_PUBLIC_KEY =
  'sb_publishable_uyLf-VUBkm18v35ArYs4nQ_78F8PSr-';

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return res.status(405).json({
      message: 'Méthode non autorisée.'
    });
  }

  const authorization =
    req.headers.authorization || '';

  const testEmail = (
    process.env.MONBOOK_TEST_EMAIL || ''
  ).trim().toLowerCase();

  const apiKey = process.env.JEKO_API_KEY;
  const keyId = process.env.JEKO_API_KEY_ID;

  if (!testEmail || !apiKey || !keyId) {
    return res.status(503).json({
      message: 'Configuration Jèko incomplète.'
    });
  }

  if (
    !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
  ) {
    return res.status(401).json({
      message: 'Connectez-vous à Mon Book.'
    });
  }

  try {
    const response = await fetch(
      SUPABASE_URL + '/auth/v1/user',
      {
        headers: {
          apikey: SUPABASE_PUBLIC_KEY,
          Authorization: authorization
        }
      }
    );

    if (!response.ok) {
      return res.status(401).json({
        message: 'Session expirée. Reconnectez-vous.'
      });
    }

    const user = await response.json();

    const email = (
      user.email || ''
    ).trim().toLowerCase();

    if (
      !user.id ||
      !user.email_confirmed_at ||
      email !== testEmail
    ) {
      return res.status(403).json({
        message: 'Accès réservé au compte de test.'
      });
    }

    const stores = await fetch(
      'https://api.jeko.africa/partner_api/stores',
      {
        headers: {
          'X-API-KEY': apiKey,
          'X-API-KEY-ID': keyId
        }
      }
    );

    if (!stores.ok) {
      return res.status(502).json({
        message:
          'Jèko n’a pas accepté la demande. Vérifiez les réglages API dans Vercel.'
      });
    }

    const data = await stores.json();

    if (!Array.isArray(data)) {
      return res.status(502).json({
        message: 'Réponse Jèko inattendue.'
      });
    }

    const result = data
      .filter(function (store) {
        return (
          store &&
          typeof store.id === 'string' &&
          /^[0-9a-f-]{36}$/i.test(store.id)
        );
      })
      .map(function (store) {
        return {
          id: store.id,
          name: String(store.name || 'Magasin')
        };
      });

    return res.status(200).json({
      magasins: result
    });
  } catch (error) {
    return res.status(503).json({
      message: 'Service temporairement indisponible.'
    });
  }
};
