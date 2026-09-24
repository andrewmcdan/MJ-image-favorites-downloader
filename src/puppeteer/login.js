async function waitForLoginCompletion({ isComplete, wait, maxAttempts = 300 }) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (isComplete()) return true;
        await wait();
    }
    return isComplete();
}

async function clickVisibleElementByText(page, labels) {
    return page.evaluate((expectedLabels) => {
        const normalizedLabels = expectedLabels.map((label) => label.trim().toLowerCase());
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
        const element = candidates.find((candidate) => {
            const text = candidate.textContent?.replace(/\s+/g, " ").trim().toLowerCase();
            const style = window.getComputedStyle(candidate);
            const visible = style.display !== "none" && style.visibility !== "hidden" && candidate.getClientRects().length > 0;
            return visible && normalizedLabels.includes(text);
        });
        if (!element) return false;
        element.click();
        return true;
    }, labels);
}

async function triggerGoogleLogin(page, wait = () => Promise.resolve()) {
    const loginClicked = await clickVisibleElementByText(page, ["Log in", "Login", "Sign in"]);
    if (!loginClicked) throw new Error("Midjourney login button was not found");
    await wait();
    const googleClicked = await clickVisibleElementByText(page, ["Continue with Google", "Sign in with Google"]);
    if (!googleClicked) throw new Error("Midjourney Google login button was not found");
}

function isAuthenticatedLikesProbe(probe) {
    return probe?.ok === true && probe?.isArray === true;
}

module.exports = { waitForLoginCompletion, clickVisibleElementByText, triggerGoogleLogin, isAuthenticatedLikesProbe };
