const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, next, setupRoom } = require("./helpers");
const { clientIp, ipKey } = require("../game/limits");

// A client that appears to come from `ip` (as Cloudflare would report it).
const from = (ip) => ({ extraHeaders: { "cf-connecting-ip": ip } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("client addresses: Cloudflare's header wins, IPv6 is grouped by /64", () => {
  assert.equal(clientIp({ headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" } }).ip, "1.2.3.4");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" } }).ip, "5.6.7.8");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }).ip, "127.0.0.1");
  assert.equal(ipKey("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  assert.equal(ipKey("2001:db8:aa:bb::9"), ipKey("2001:0db8:00aa:00bb:ffff::1"));
  assert.notEqual(ipKey("2001:db8:aa:bb::1"), ipKey("2001:db8:aa:cc::1"));
});

test("one address can only hold so many connections", async (t) => {
  const srv = await startServer({ maxSocketsPerIp: 3 });
  t.after(() => srv.stop());
  const mine = [];
  for (let i = 0; i < 3; i++) mine.push(await srv.client(from("1.1.1.1")));
  await assert.rejects(srv.client(from("1.1.1.1")));
  // Another network is unaffected.
  assert.equal((await srv.client(from("2.2.2.2"))).connected, true);
  // A freed slot can be used again.
  mine[0].close();
  await wait(100);
  assert.equal((await srv.client(from("1.1.1.1"))).connected, true);
});

test("the instance refuses connections past its total cap", async (t) => {
  const srv = await startServer({ maxConnections: 2 });
  t.after(() => srv.stop());
  await srv.client(from("1.1.1.1"));
  await srv.client(from("2.2.2.2"));
  await assert.rejects(srv.client(from("3.3.3.3")));
});

test("one address can't take every room slot", async (t) => {
  const srv = await startServer({ maxRoomsPerIp: 2 });
  t.after(() => srv.stop());
  const s = await srv.client(from("1.1.1.1"));
  for (let i = 0; i < 2; i++) {
    const joined = next(s, "roomJoined");
    s.emit("createRoom", { name: `Host ${i}` });
    const { room } = await joined;
    assert.equal("creatorIp" in room, false, "the address is never sent to clients");
  }
  const err = next(s, "errorMessage");
  s.emit("createRoom", { name: "Third" });
  assert.match(await err, /too many rooms/i);

  const other = await srv.client(from("2.2.2.2"));
  const joined = next(other, "roomJoined");
  other.emit("createRoom", { name: "Neighbour" });
  await joined;
});

test("sockets from one address share an event budget", async (t) => {
  const srv = await startServer({
    rateLimit: { capacity: 100, refillPerSec: 100 },
    ipRateLimit: { capacity: 10, refillPerSec: 1 },
  });
  t.after(() => srv.stop());
  const a = await srv.client(from("1.1.1.1"));
  const b = await srv.client(from("1.1.1.1"));
  const elsewhere = await srv.client(from("2.2.2.2"));
  const warned = next(b, "errorMessage", (m) => /slow down/i.test(m));
  for (let i = 0; i < 8; i++) a.emit("getCharacterList");
  for (let i = 0; i < 8; i++) b.emit("getCharacterList");
  await warned;
  // Someone on another network still gets answers.
  const list = next(elsewhere, "characterListUpdate");
  elsewhere.emit("getCharacterList");
  await list;
});

test("a room nobody joined is let go soon after its host leaves", async (t) => {
  const srv = await startServer({ loneRoomIdleMs: 50, roomIdleMs: 60 * 60 * 1000 });
  t.after(() => srv.stop());
  const lone = await setupRoom(srv, 1);
  const pair = await setupRoom(srv, 2);
  [...lone.players, ...pair.players].forEach((p) => p.socket.close());
  await wait(200);
  srv.sweepRooms();
  assert.equal(srv.rooms[lone.roomCode], undefined);
  // A room people actually joined keeps the normal grace period.
  assert.ok(srv.rooms[pair.roomCode]);
});

test("HTTP requests are rate limited per address", async (t) => {
  const srv = await startServer({ httpLimit: { max: 3, windowMs: 60 * 1000 } });
  t.after(() => srv.stop());
  const get = (ip) => fetch(`${srv.url}/`, { headers: { "cf-connecting-ip": ip } }).then((r) => r.status);
  for (let i = 0; i < 3; i++) assert.equal(await get("1.1.1.1"), 200);
  assert.equal(await get("1.1.1.1"), 429);
  assert.equal(await get("2.2.2.2"), 200);
});
