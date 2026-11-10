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

// Shown before the room loads, and when a room has no name.
export const DEFAULT_ROOM_NAME = "DJ Room";

// Applies the DJ's room name and accent color. Text on accent-colored buttons turns black or white to stay readable.
export function applyRoom(room, subtitle) {
    const name = room.name ?? DEFAULT_ROOM_NAME;
    byId("title").textContent = name;
    document.title = `${name} · ${subtitle}`;
    byId("search-heading").textContent = room.autoQueue ? "Queue a song" : "Request a song";
    const rootStyle = document.documentElement.style;
    if (room.accent) {
        rootStyle.setProperty("--accent", room.accent);
        rootStyle.setProperty("--on-accent", luminance(room.accent) > 0.179 ? "#000" : "#fff");
    } else {
        rootStyle.removeProperty("--accent");
        rootStyle.removeProperty("--on-accent");
    }
}

// WCAG relative luminance of a #rrggbb color; 0.179 is where black and white text have equal contrast.
function luminance(hex) {
    const [red, green, blue] = [1, 3, 5].map((start) => {
        const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// Inline SVG icons (element() can't create SVG nodes), drawn on a 24x24 grid.
const ICONS = {
    addToQueue: "M3 7h8M3 13h18M3 19h18M19 1v8M15 5h8",
    reject: "M6 6l12 12M18 6L6 18",
};

function icon(name) {
    const svgNamespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNamespace, "svg");
    const attributes = {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "aria-hidden": "true",
    };
    for (const [attribute, value] of Object.entries(attributes)) {
        svg.setAttribute(attribute, value);
    }
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
}

// A square icon button for a card's .actions group; the label is for screen readers and the hover tooltip.
export function iconButton(name, label, className, onclick) {
    return element("button", { class: className, "aria-label": label, title: label, onclick }, icon(name));
}
