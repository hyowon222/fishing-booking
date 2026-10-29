// 설치(홈 화면 추가)용 최소 서비스 워커. 화면·데이터를 저장해 두지 않고 항상 서버에서 바로 받아 오기 때문에,
// 사이트를 업데이트하면 앱도 자동으로 최신 화면이 된다. 인터넷이 없을 때만 안내 문구를 보여 준다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() =>
      event.request.mode === 'navigate'
        ? new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem"><h3>인터넷에 연결되어 있지 않아요</h3><p>연결을 확인한 뒤 다시 열어 주세요.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : Response.error(),
    ),
  );
});
