// Decode NextAuth v5 JWE token using @auth/core
// Called from Python as subprocess: node decode_token.mjs <token> <secret> <salt>
import { decode } from '@auth/core/jwt';

const [,, token, secret, salt] = process.argv;

if (!token || !secret || !salt) {
  console.error(JSON.stringify({ error: 'Usage: node decode_token.mjs <token> <secret> <salt>' }));
  process.exit(1);
}

try {
  const payload = await decode({ token, secret, salt });
  console.log(JSON.stringify(payload));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
