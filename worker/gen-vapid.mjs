// VAPID の鍵を1組作る。公開鍵はページに、秘密鍵（JWK）は Worker の secret に入れる。
const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
const b64u = b => Buffer.from(b).toString('base64url');
const jwk = await crypto.subtle.exportKey('jwk', k.privateKey);
console.log('VAPID_PUBLIC=' + b64u(raw));
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify(jwk));
