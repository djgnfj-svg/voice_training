// Decode NextAuth v5 JWE token using @auth/core
// Called from Python as subprocess: receives JSON via stdin {token, secret, salt}
import { decode } from '@auth/core/jwt';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());

const { token, secret, salt } = input;

if (!token || !secret || !salt) {
  console.error(JSON.stringify({ error: 'Missing token, secret, or salt in stdin JSON' }));
  process.exit(1);
}

try {
  const payload = await decode({ token, secret, salt });
  console.log(JSON.stringify(payload));
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
