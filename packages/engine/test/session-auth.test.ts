import { afterEach, describe, expect, it } from "vitest";
import { callHost, checkApiConnection, HostCallFailed } from "../src/host/api";
import { startStubHost, type StubState } from "./stub-host";

// The session sign-in (spec 11.12, D183) against the stub host's Laravel-style login: the CSRF cookie, the login, the
// cookie jar, one sign-in again when the session is refused, and the connection test.

const hosts: Awaited<ReturnType<typeof startStubHost>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function sessionApp(state: StubState = {}) {
  const stub = await startStubHost({ session: true }, state);
  hosts.push(stub);
  const calls = (path: string) => stub.requests.filter((request) => request.path === path);
  return { stub, calls };
}

const read = { method: "GET", path: "/orders/ord-7" };

describe("session sign-in", () => {
  it("signs in once for calls made together, and keeps the session for later calls", async () => {
    const { stub, calls } = await sessionApp();
    const answers = await Promise.all([callHost(stub.connection, read), callHost(stub.connection, read)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    await callHost(stub.connection, read);
    expect(calls("/csrf-cookie")).toHaveLength(1);
    expect(calls("/login")).toHaveLength(1);
    // The login itself carries the CSRF token of the cookie it was given.
    expect(calls("/login")[0]!.headers["x-xsrf-token"]).toBe("csrf/1=");
    expect(calls("/login")[0]!.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  it("takes a login that redirects to the app as signed in", async () => {
    const { stub } = await sessionApp({ loginAnswer: "redirect" });
    expect((await callHost(stub.connection, read)).status).toBe(200);
  });

  it("signs in again only once: an app that still refuses gives its answer", async () => {
    const { stub, calls } = await sessionApp({ refuseSessions: true });
    const answer = await callHost(stub.connection, { method: "POST", path: "/orders", body: {} });
    expect(answer.status).toBe(401);
    expect(calls("/login")).toHaveLength(2);
    expect(calls("/orders")).toHaveLength(2);
  });

  it("says when the app refuses the login, and signs in again on the next call", async () => {
    const { stub, calls } = await sessionApp();
    const wrong = { ...stub.connection, secret: "not-the-password" };
    await expect(callHost(wrong, read)).rejects.toThrow(
      new HostCallFailed("the app refused the sign-in (422)", "auth"),
    );
    await expect(callHost(wrong, read)).rejects.toThrow(/refused the sign-in/);
    expect(calls("/login")).toHaveLength(2); // a refused sign-in is not kept
    expect(calls("/orders/ord-7")).toHaveLength(0);
  });

  it("needs its sign-in set up", async () => {
    const { stub } = await sessionApp();
    await expect(callHost({ ...stub.connection, loginConfig: null }, read)).rejects.toThrow(
      "the app's sign-in is not set up",
    );
  });

  it("tests the connection by signing in afresh", async () => {
    const { stub, calls } = await sessionApp();
    expect(await checkApiConnection(stub.connection)).toEqual({ ok: true, key: "accepted" });
    expect(await checkApiConnection(stub.connection)).toEqual({ ok: true, key: "accepted" });
    expect(calls("/login")).toHaveLength(2);
    expect(await checkApiConnection({ ...stub.connection, secret: "wrong" })).toEqual({
      ok: false,
      key: "refused",
      error: "the app refused the sign-in (422)",
    });
  });
});
