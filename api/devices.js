const SUPABASE_URL =
  'https://swgifqnatsxekmimrges.supabase.co';

const SUPABASE_PUBLIC_KEY =
  'sb_publishable_uyLf-VUBkm18v35ArYs4nQ_78F8PSr-';

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

  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!secret) {
    return reply(503, 'Le service n’est pas configuré.');
  }

  const authorization = req.headers.authorization || '';

  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) {
    return reply(401, 'Connectez-vous avant de continuer.');
  }

  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply(400, 'Demande invalide.');
  }

  if (!['register', 'list', 'remove'].includes(body.action)) {
    return reply(400, 'Action invalide.');
  }

  try {
    const userResponse = await fetch(
      SUPABASE_URL + '/auth/v1/user',
      {
        headers: {
          apikey: SUPABASE_PUBLIC_KEY,
          Authorization: authorization
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!userResponse.ok) {
      return reply(401, 'Votre session a expiré. Reconnectez-vous.');
    }

    const user = await userResponse.json();

    if (
      !UUID.test(user.id || '') ||
      !user.email_confirmed_at
    ) {
      return reply(403, 'Un compte confirmé est nécessaire.');
    }

    async function rpc(name, payload) {
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/rpc/' + name,
        {
          method: 'POST',
          headers: {
            apikey: secret,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000)
        }
      );

      if (!response.ok) {
        throw new Error('database_error');
      }

      return response.json();
    }

    async function listDevices() {
      const query = new URLSearchParams({
        user_id: 'eq.' + user.id,
        revoked_at: 'is.null',
        select: 'device_id,device_label,created_at,last_seen_at',
        order: 'last_seen_at.desc'
      });

      const response = await fetch(
        SUPABASE_URL + '/rest/v1/mon_book_devices?' + query.toString(),
        {
          headers: {
            apikey: secret
          },
          signal: AbortSignal.timeout(8000)
        }
      );

      if (!response.ok) {
        throw new Error('database_error');
      }

      const rows = await response.json();
      if (!Array.isArray(rows)) {
        throw new Error('database_error');
      }

      return rows.map(function (row) {
        return {
          deviceId: row.device_id,
          label: row.device_label,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at
        };
      });
    }

    if (body.action === 'register') {
      const deviceId =
        typeof body.deviceId === 'string'
          ? body.deviceId.trim()
          : '';

      if (!UUID.test(deviceId)) {
        return reply(400, 'Identifiant d’appareil invalide.');
      }

      const label =
        typeof body.label === 'string'
          ? body.label.trim().slice(0, 80)
          : 'Navigateur web';

      const result = await rpc(
        'mon_book_register_device',
        {
          p_user: user.id,
          p_device: deviceId,
          p_label: label || 'Navigateur web'
        }
      );

      if (result === 'ok') {
        return reply(200, 'Appareil enregistré.', {
          status: 'ok',
          deviceId
        });
      }

      if (result === 'limit') {
        return reply(409, 'Deux appareils sont déjà enregistrés.', {
          status: 'limit',
          devices: await listDevices()
        });
      }

      return reply(400, 'Impossible d’enregistrer cet appareil.');
    }

    if (body.action === 'list') {
      return reply(200, 'Appareils enregistrés.', {
        devices: await listDevices()
      });
    }

    const deviceId =
      typeof body.deviceId === 'string'
        ? body.deviceId.trim()
        : '';

    if (!UUID.test(deviceId)) {
      return reply(400, 'Identifiant d’appareil invalide.');
    }

    const result = await rpc(
      'mon_book_revoke_device',
      {
        p_user: user.id,
        p_device: deviceId
      }
    );

    if (result !== 'removed' && result !== 'not_found') {
      return reply(400, 'Impossible de retirer cet appareil.');
    }

    return reply(200, 'Liste des appareils mise à jour.', {
      status: result,
      devices: await listDevices()
    });
  } catch (error) {
    return reply(
      503,
      'Le service des appareils est indisponible. Réessayez.'
    );
  }
};
