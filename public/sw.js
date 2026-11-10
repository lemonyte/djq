// Service worker for DJ notifications: shows each push, and opens the DJ console when one is tapped.

self.addEventListener("push", (event) => {
    const data = event.data?.json() ?? {};
    event.waitUntil(
        self.registration.showNotification(data.title ?? "New song request", {
            body: data.body,
            tag: data.tag,
            data: { url: data.url ?? "/" },
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const open = windows.find((client) => new URL(client.url).pathname === target.pathname);
            if (open) {
                return open.focus();
            }
            return self.clients.openWindow(target.href);
        })(),
    );
});
