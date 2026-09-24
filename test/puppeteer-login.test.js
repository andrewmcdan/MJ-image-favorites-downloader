const assert = require("node:assert/strict");
const test = require("node:test");

const { waitForLoginCompletion, triggerGoogleLogin, isAuthenticatedLikesProbe } = require("../src/puppeteer/login");

test("login wait completes after an asynchronous login signal", async () => {
    let attempts = 0;
    const completed = await waitForLoginCompletion({
        isComplete: () => attempts === 2,
        wait: async () => {
            attempts++;
        },
        maxAttempts: 3,
    });
    assert.equal(completed, true);
    assert.equal(attempts, 2);
});

test("login wait returns false after its attempt limit", async () => {
    let attempts = 0;
    const completed = await waitForLoginCompletion({
        isComplete: () => false,
        wait: async () => {
            attempts++;
        },
        maxAttempts: 3,
    });
    assert.equal(completed, false);
    assert.equal(attempts, 3);
});

test("Google login trigger clicks Midjourney login before the Google provider", async () => {
    const calls = [];
    const page = {
        evaluate: async (_callback, labels) => {
            calls.push(labels);
            return true;
        },
    };
    let waited = false;
    await triggerGoogleLogin(page, async () => {
        waited = true;
    });
    assert.equal(waited, true);
    assert.deepEqual(calls, [
        ["Log in", "Login", "Sign in"],
        ["Continue with Google", "Sign in with Google"],
    ]);
});

test("Google login trigger reports a missing provider button", async () => {
    const results = [true, false];
    const page = { evaluate: async () => results.shift() };
    await assert.rejects(() => triggerGoogleLogin(page), /Google login button was not found/);
});

test("saved sessions are accepted only when the Likes API returns an array", () => {
    assert.equal(isAuthenticatedLikesProbe({ ok: true, status: 200, isArray: true }), true);
    assert.equal(isAuthenticatedLikesProbe({ ok: true, status: 200, isArray: false }), false);
    assert.equal(isAuthenticatedLikesProbe({ ok: false, status: 401, isArray: false }), false);
});
