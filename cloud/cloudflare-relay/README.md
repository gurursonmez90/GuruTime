# GuruTime Cloudflare Relay

GuruTime’ın isteğe bağlı telefon erişimi için Cloudflare Worker + Static Assets + SQLite Durable Objects uygulamasıdır. Masaüstü görevleri ve Mac alarmı relay kapalıyken de çalışır. Relay tam görev listesi veya düz metin komut saklamaz; telefon komutlarının AES-GCM ciphertext zarfını geçici olarak iletir.

## Mimari

- `Registry`: sunucu tarafından `installationId` ve 256-bit cihaz sırrı üretir, saatlik hash’lenmiş IP oran sınırını uygular. Cihaz sırrının yalnız HMAC özeti saklanır.
- Kurulum başına `Installation`: en fazla beş telefon, tek controller WebSocket, komut kuyruğu, alarm occurrence kayıtları ve Web Push aboneliklerini kendi SQLite deposunda izole eder.
- Hibernating WebSocket: controller bağlantısı Durable Object uyurken açık kalır. `ping` → `pong` otomatik yanıtı DO’yu uyandırmaz; kodda interval yoktur.
- Static Assets PWA: davet fragment’ını okur, eşleştirme anahtarını IndexedDB’de tutar, komutu tarayıcıda AES-256-GCM ile şifreler ve standart Service Worker Web Push kullanır. Yalnız `/api/*` Worker-first’tür; PWA dosyaları ücretsiz Static Assets yolundan, aynı güvenlik başlıklarını `public/_headers` üzerinden alır.
- `Registry` dışında global veri katmanı yoktur. Her kurulum doğal izolasyon sınırıdır.

Sunucunun gördüğü metadata: kurulum/telefon/key kimlikleri, komut türü, ciphertext boyutu, zamanlar, `alarmId + occurrence + fireAt` ve Push endpoint/anahtarları. Görev başlığı ve alarm metni şifreli zarfın içindedir.

## Yerel geliştirme

Gereksinimler: Node.js 20+ ve bir Cloudflare hesabı.

```sh
cd cloud/cloudflare-relay
npm install
cp .dev.vars.example .dev.vars
npm run check
npm test
npm run dev
```

`.dev.vars` içindeki iki temel değeri ayrı rastgele değerlerle üretin:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Yerelde `TURNSTILE_SECRET` ve VAPID değerleri boş bırakılabilir. Bu durumda enrollment doğrulama hook’u atlanır ve bildirim aboneliği kapalı görünür. Public yayında Turnstile zorunlu tutulmalıdır.

## Production dağıtımı

1. `wrangler.jsonc` içindeki `PUBLIC_APP_ORIGIN` değerini kalıcı özel origin ile, `TURNSTILE_SITE_KEY` değerini Turnstile’ın public site key’iyle değiştirin. `workers.dev` yalnız geliştirme/beta içindir.
2. Cloudflare Turnstile’da bu hostname için widget oluşturun. Desktop enrollment görünümünde `GET /api/v1/config` içindeki site key ile token üretip `turnstileToken` alanına gönderin. `ENVIRONMENT=production` iken secret yoksa enrollment güvenli biçimde `503` döner.
3. VAPID P-256 anahtar çiftini bir kez üretin. Örneğin geçici olarak `npx web-push generate-vapid-keys --json` kullanılabilir. Public key uygulamaya açık, private key sırdır.
4. Sırları yükleyin:

```sh
npx wrangler secret put AUTH_PEPPER
npx wrangler secret put INTERNAL_SECRET
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

5. Önce dry-run ve test, sonra deploy çalıştırın:

```sh
npm ci
npm run check
npm test
npx wrangler deploy --dry-run --outdir dist
npm run deploy
```

6. Workers & Pages → Custom Domains üzerinden aynı Worker’a `app.example.com` bağlayın. CSP ve SameSite davranışı nedeniyle PWA/API aynı origin’de kalmalıdır.

`AUTH_PEPPER` ve `INTERNAL_SECRET` birbirinden bağımsız, en az 32 karakter olmalıdır. `AUTH_PEPPER` kaybolursa mevcut cihaz/telefon/ticket hash’leri doğrulanamaz; güvenli bir secret manager’da yedekleyin. Secret rotation şu an yeniden enrollment/eşleştirme gerektirir.

Turnstile hook’u yalnız secret yapılandırılmışsa zorunludur; production öncesi `GET /api/v1/config` yanıtındaki `turnstileRequired: true` kontrol edilmelidir. Ayrıca Cloudflare WAF ile `/api/v1/installations/enroll` için edge rate-limit kuralı eklemek katmanlı koruma sağlar. Uygulama içi limit varsayılan olarak IP başına 5 enrollment/saat’tir.

### R2 yayın dosyaları

Relay’in Static Assets’i PWA içindir. DMG/update dosyalarını ayrı bir R2 bucket ve `downloads.example.com` özel domain’iyle yayınlayın:

```sh
npx wrangler r2 bucket create gurutime-downloads
npx wrangler r2 object put gurutime-downloads/releases/1.1.0/GuruTime-universal.dmg --file ./GuruTime-universal.dmg
```

Sürüm yollarını immutable tutun, stable/beta manifestlerini imzalayın ve son beş sürümü koruyun. `r2.dev` production için kullanılmamalıdır. Google Drive canlı relay/WebSocket sunucusu değildir; yalnız şifreli artefact yedeği olarak kullanılabilir.

## Masaüstü protokolü

Tüm JSON isteklerinde `Content-Type: application/json` kullanılır. Native istemci `Origin` göndermeyebilir; gönderirse API origin’iyle aynı olmalıdır. Bearer/token query string’de taşınmaz ve wildcard CORS yoktur.

### Enrollment ve cihaz auth

```http
POST /api/v1/installations/enroll
{"turnstileToken":"..."}
```

Yanıt yalnız bir kez `{ installationId, deviceSecret, createdAt }` döndürür. `deviceSecret` Keychain / Electron `safeStorage` içinde tutulmalıdır. Cihaz endpoint’leri:

```http
X-GuruTime-Installation: <installationId>
Authorization: GuruTimeDevice <deviceSecret>
```

### Controller WebSocket

1. `POST /api/v1/controller/ticket` cihaz auth ile çağrılır; 60 saniyelik tek kullanımlık `{ ticket, expiresAt }` döner.
2. `wss://app.example.com/api/v1/controller/socket/<installationId>` bağlantısı açılır. Query bearer yerine şu subprotocol listesi gönderilir:

```text
gurutime.v1, ticket.<ticket>
```

Yeni controller eski controller’ı `4001` ile kapatır. Bağlantıda en eski üç komut hemen lease edilir; send hatasında üç senkron deneme yapılır. Reconnect eski controller lease’lerini tekrar `queued` yapıp ilk üç komutu yollar.

Server komut frame’i:

```json
{
  "type": "command",
  "commandId": "phone-...",
  "phoneId": "...",
  "keyId": "...",
  "kind": "task.create",
  "ciphertext": "<base64url(iv || AES-GCM ciphertext+tag)>",
  "leaseToken": "...",
  "leasedUntil": 0,
  "expiresAt": 0,
  "attempt": 1
}
```

Mac, `keyId` ile doğru eşleştirme anahtarını Keychain’den seçer; ilk 12 baytı IV kabul edip kalan zarfı AES-256-GCM ile açar. Komutu kendi kalıcı `processedCloudCommandIds` kümesine yazdıktan sonra ACK gönderir:

```json
{"type":"ack","commandId":"phone-...","leaseToken":"..."}
```

ACK kaybolursa komut yeniden gelebilir; masaüstü `commandId` ile idempotent olmalıdır. `ping` metin frame’ine `pong` runtime tarafından otomatik döner. `setInterval` gerekmez.

### Eşleştirme ve ayrı anahtarlar

```http
POST /api/v1/controller/invites
{"requirePin":true}
```

Yanıt `{ inviteId, keyId, pairingKey, inviteUrl, pin, pinRequired, expiresAt }` içerir. `pairingKey` ve fragment içindeki `k` aynı 256-bit AES anahtarıdır; relay yalnız hash’ini saklar. Mac bu yanıtı alır almaz Keychain’e `keyId → pairingKey` kaydetmelidir. Her davet yeni bir `keyId/pairingKey` üretir; böylece beş telefon birbirinin anahtarını kullanamaz. `GET /api/v1/controller/phones` ve komut frame’i `keyId` döndürür; telefon iptal edilince Mac ilgili key’i de silebilir.

Fragment örneği, HTTP isteğinde sunucuya gönderilmez:

```text
/#pair=<base64url({v:1,i:installationId,n:inviteId,x:keyId,k:pairingKey})>
```

Davette PIN varsayılan açıktır; `{ "requirePin": false }` yalnız kullanıcı doğrudan ekrandaki QR’ı tararken seçilmelidir. Davet 10 dakika/tek kullanımlıktır. Beş yanlış PIN 15 dakika kilitler. En fazla beş aktif telefon vardır. Başarılı claim yalnız `Secure; HttpOnly; SameSite=Strict; Path=/` `__Host-` cookie üretir; PWA cookie değerini okuyamaz.

### Telefon ve alarm endpoint’leri

| Method | Yol | Auth | Gövde / davranış |
|---|---|---|---|
| `GET` | `/api/v1/config` | yok | VAPID public key ve limitler |
| `POST` | `/api/v1/pairing/claim` | invite secret + opsiyonel PIN | `installationId, inviteId, pairingSecret, pin?, deviceName?` |
| `POST` | `/api/v1/commands` | session cookie | `commandId, kind, ciphertext, fireAt?` |
| `PUT` | `/api/v1/push/subscription` | session cookie | standart `PushSubscription` JSON |
| `DELETE` | `/api/v1/push/subscription` | session cookie | aboneliği kaldırır |
| `POST` | `/api/v1/session/logout` | session cookie | session’ı geçersizleştirir |
| `GET` | `/api/v1/controller/phones` | device | bağlı telefonları/keyId’leri listeler |
| `DELETE` | `/api/v1/controller/phones/<phoneId>` | device | telefonu ve push aboneliğini iptal eder |
| `PUT` | `/api/v1/controller/alarms` | device | `alarmId, occurrence, fireAt` planlar/upsert eder |
| `DELETE` | `/api/v1/controller/alarms` | device | `alarmId, occurrence` iptal eder |

Komut gövdesi en fazla 4 KB, kuyruk 100, oran kurulum başına 20/dakikadır. Telefon alarmı 1 dakika-24 saat aralığında olmalıdır. Görev komutu 7 gün; alarm komutu `fireAt + 15 dakika` sonunda `expired` olur. Durumlar `queued → leased → acked`; TTL geçen kayıt `expired` olur. Lease 30 saniyedir ve teslimat at-least-once’dur.

Alarm tablosunda yalnız `alarmId + occurrence + fireAt` tutulur. Composite primary key occurrence replay’ini yutar. Durable Object’ın tek alarm slotu, sıradaki telefon alarmı ile en yakın command lease süresinin minimumuna planlanır; due kayıtları işler ve bir sonrakini kurar. Push içeriği varsayılan olarak yalnız “Bir zamanlayıcınız sona erdi.” metnidir. Push servisinin `404/410` yanıtı aboneliği siler.

## Güvenlik ve operasyon notları

- Uzun ömürlü credential URL/query içinde değildir. Invite fragment browser tarafından ağa gönderilmez.
- CSP, HSTS, `frame-ancestors 'none'`, COOP/CORP, no-referrer ve Permissions-Policy her HTTP yanıta uygulanır.
- CORS header’ı yoktur; cross-origin `Origin`/`Sec-Fetch-Site` reddedilir. SameSite Strict cookie ve JSON content type CSRF yüzeyini daraltır.
- Relay ciphertext’i doğrulayamaz; yalnız base64url biçim/boyut kontrolü yapar. Gerçek AES-GCM doğrulaması Mac’te gerçekleşir.
- Alarm occurrence işareti dış Push çağrısından önce kalıcılaştırılır; bu duplicate push’u önler. Push sağlayıcı geçici hata verirse yerel Mac alarmı birincil kanal olduğundan occurrence otomatik tekrar gönderilmez.
- Web Push için iOS/iPadOS’ta PWA’nın Ana Ekran’a eklenmesi ve kullanıcı etkileşimiyle izin verilmesi gerekir.
- Gözlenecek metrikler: Worker/DO hata oranı, WebSocket sayısı, command ACK gecikmesi, queue depth, push 4xx/5xx ve günlük request/storage kullanımı. Payload/ciphertext loglanmamalıdır.

Test paketi gerçek `workerd`/SQLite Durable Object ortamında kurulum izolasyonu, iki telefonun ayrı E2EE keyId’si, davet replay, PIN kilidi, queue/lease/ACK idempotency, alarm occurrence dedupe ve cross-origin güvenlik başlıklarını doğrular.

### 250 bağlantı staging yük testi

Turnstile secret’ı kapalı, erişimi geçici WAF kuralıyla sınırlandırılmış ayrı bir staging Worker’da 250 bağımsız kurulum ve hibernating controller socket’i açmak için:

```sh
GURUTIME_LOAD_ALLOW=1 \
GURUTIME_LOAD_ORIGIN=https://staging-app.example.com \
npm run test:load
```

Test varsayılan olarak 25 eşzamanlı enrollment ile 250 socket açar, 65 saniye trafiksiz tutar ve tamamının açık kaldığını doğrular. Production origin üzerinde çalıştırmayın. Kurulum sayısı, concurrency ve bekleme süresi sırasıyla `GURUTIME_LOAD_INSTALLATIONS`, `GURUTIME_LOAD_CONCURRENCY` ve `GURUTIME_LOAD_HOLD_MS` ile değiştirilebilir.
