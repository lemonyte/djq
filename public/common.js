// The room this page belongs to, e.g. "/r/<id>"; API and WebSocket paths go under it.
export const base = location.pathname.match(/^\/r\/[0-9a-f]{64}/)?.[0] ?? "";

export const byId = (id) => document.getElementById(id);

// Tiny DOM helper: element("li", {class: "x", onclick}, child, "text")
export function element(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (name.startsWith("on")) {
            node.addEventListener(name.slice(2), value);
        } else if (value !== false && value != null) {
            node.setAttribute(name, value === true ? "" : value);
        }
    }
    node.append(...children.flat().filter((child) => child != null && child !== false));
    return node;
}

// spotify:track:<id> -> https://open.spotify.com/track/<id>, which opens the app on phones and the web player elsewhere
function spotifyUrl(uri) {
    const match = uri?.match(/^spotify:(track|episode):([A-Za-z0-9]+)$/);
    return match ? `https://open.spotify.com/${match[1]}/${match[2]}` : null;
}

export function trackItem(track, ...actions) {
    const url = spotifyUrl(track.uri);
    const title = url
        ? element("a", { href: url, target: "_blank", rel: "noopener" }, track.title)
        : element("b", {}, track.title);
    return element(
        "li",
        { class: track.mine ? "track mine" : "track" },
        track.art ? element("img", { src: track.art, alt: "" }) : element("div", { class: "noart" }),
        element("div", { class: "meta" }, title, element("span", {}, track.artist)),
        ...actions,
    );
}

export function list(container, items, empty, render) {
    container.replaceChildren(...(items.length ? items.map(render) : [element("li", { class: "empty" }, empty)]));
}

export function toast(message) {
    const node = byId("toast");
    node.textContent = message;
    node.style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (node.style.display = "none"), 4000);
}

export async function api(path, { body, key } = {}) {
    const res = await fetch(base + path, {
        method: body !== undefined || key ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...(key && { Authorization: `Bearer ${key}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error ?? `Error ${res.status}`);
    }
    return data;
}

// Keeps a WebSocket open and calls onState with each state message.
export function live(query, onState) {
    const open = () => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}${base}/api/ws?${query}`);
        ws.onmessage = (event) => onState(JSON.parse(event.data));
        ws.onclose = () => setTimeout(open, 2000);
    };
    open();
}
