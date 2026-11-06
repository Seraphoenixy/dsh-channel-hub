import manifest from "../../package.json" with { type: "json" };

/** Keep OFM product identities; use our own identity where the adapter has none. */
export const CHANNEL_USER_AGENT = `dsh-channel-hub/${manifest.version} (+https://github.com/Seraphoenixy/dsh-channel-hub)`;

export function withChannelUserAgent(base: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const ua = headers.get("user-agent");
    if (ua?.trim() && !/\bdeepseek-harness\//i.test(ua)) {
      return base(input, init);
    }
    headers.set("User-Agent", CHANNEL_USER_AGENT);
    return base(input, { ...init, headers });
  };
}

export const channelFetch: typeof fetch = withChannelUserAgent((input, init) =>
  globalThis.fetch(input, init),
);
