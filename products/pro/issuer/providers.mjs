// Fixed production origins. Only GitHub sees its OAuth token, and only Stripe sees
// the billing secret. An account is keyed by GitHub's immutable numeric user ID.
export function providers(cfg, request = fetch) {
  async function json(url, init) {
    const r = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("Upstream service unavailable");
    return r.json();
  }

  const github = (path, fields) =>
    json("https://github.com/login/" + path, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(fields),
    });
  const stripe = (path, fields, key) =>
    json("https://api.stripe.com/v1/" + path, {
      method: fields ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + cfg.stripe_key,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(fields ? { body: new URLSearchParams(fields) } : {}),
    });
  return {
    start: () => github("device/code", { client_id: cfg.github_client_id }),
    async identity(device_code) {
      const oauth = await github("oauth/access_token", {
        client_id: cfg.github_client_id,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (oauth.error) return { error: oauth.error };
      if (typeof oauth.access_token !== "string" || !oauth.access_token)
        throw new Error("No GitHub access token");
      const user = await json("https://api.github.com/user", {
        headers: {
          Authorization: "Bearer " + oauth.access_token,
          Accept: "application/vnd.github+json",
          "User-Agent": "REA-Pro-Issuer",
        },
      });
      if (!Number.isSafeInteger(user.id) || user.id <= 0)
        throw new Error("No GitHub identity");
      return { subject: String(user.id) };
    },
    async customer(subject, key) {
      const c = await stripe(
        "customers",
        { "metadata[rea_github_id]": subject },
        key,
      );
      if (!/^cus_[A-Za-z0-9]+$/.test(c.id))
        throw new Error("Invalid billing account");
      return c.id;
    },
    async subscribed(customer) {
      for (const status of ["active", "trialing"]) {
        const q = new URLSearchParams({
          customer,
          status,
          price: cfg.price_id,
          limit: "1",
        });
        const list = await stripe("subscriptions?" + q);
        if (!Array.isArray(list.data))
          throw new Error("Invalid subscription response");
        if (list.data.length) return true;
      }
      return false;
    },
    async checkout(customer, subject, key) {
      const s = await stripe(
        "checkout/sessions",
        {
          mode: "subscription",
          customer,
          client_reference_id: subject,
          "line_items[0][price]": cfg.price_id,
          "line_items[0][quantity]": "1",
          success_url: cfg.issuer + "/complete",
          cancel_url: cfg.issuer + "/cancelled",
        },
        key,
      );
      const url = new URL(s.url);
      if (url.origin !== "https://checkout.stripe.com")
        throw new Error("Invalid Checkout URL");
      return url.href;
    },
  };
}
