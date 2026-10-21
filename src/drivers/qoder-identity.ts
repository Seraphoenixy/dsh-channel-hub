import { fetchQoderUserNickname, type QoderCredential } from "../../vendor/ofm/src/qoder.ts";
import type { QoderProduct } from "../../vendor/ofm/src/qoder-product.ts";

interface AccountIdentity {
  id: string;
  provider: string;
  credentialRef: string;
  nickname?: string;
}

function missingName(account: AccountIdentity) {
  return !account.nickname?.trim() || account.nickname.trim() === account.id;
}

/** Recover only generated labels; never overwrite a user's account name or credentials. */
export async function syncQoderAccountName(options: {
  account: AccountIdentity;
  credential: QoderCredential;
  product: QoderProduct;
  getAccount: (id: string) => AccountIdentity | undefined;
  readCredential: (account: AccountIdentity) => Promise<QoderCredential | undefined>;
  updateAccount: (id: string, patch: { nickname: string }) => Promise<void>;
  fetcher?: typeof fetch;
}) {
  const { account, credential, product } = options;
  if (account.provider !== product.id || !missingName(account)) return;
  const nickname = credential.nickname?.trim() ||
    await fetchQoderUserNickname(credential, product, options.fetcher);
  if (!nickname || nickname === account.id) return;
  const current = options.getAccount(account.id);
  if (!current || current.provider !== account.provider || current.credentialRef !== account.credentialRef) return;
  const latestCredential = await options.readCredential(current);
  // A login/renewal/removal may finish while userinfo is in flight. A later
  // refresh can retry metadata; this result must not rename a different login.
  if (!latestCredential ||
      latestCredential.access_token !== credential.access_token ||
      latestCredential.security_oauth_token !== credential.security_oauth_token) return;
  const latest = options.getAccount(account.id);
  if (!latest || latest.provider !== account.provider || latest.credentialRef !== account.credentialRef || !missingName(latest)) return;
  await options.updateAccount(account.id, { nickname });
}
