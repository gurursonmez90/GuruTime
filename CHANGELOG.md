# Değişiklik Günlüğü

Bu projedeki önemli değişiklikler bu dosyada belgelenir.

## 1.2.0 — 12 Temmuz 2026

### Yeni

- GitHub Releases ve `main` dalındaki sürüm numarasını denetleyen otomatik güncelleme bildirimi
- Ayarlar ekranında yayın kanalı seçimi ve elle **Şimdi denetle** eylemi
- Yeni warm-glass görev, bağlantı ve ayarlar arayüzü; hareketli SVG ayrıntıları
- Menü çubuğu halatının tepsi simgesiyle kesintisiz çalışan yerel bağlantısı

### İyileştirildi

- GitHub sayfasında GIF ilk sıraya alındı, kurulum tek Terminal komutuna indirildi ve ekran görüntüleri yenilendi.
- İmzalı özel yayın akışı korunurken, indirme origin'i yapılandırılmamış kurulumlara GitHub bildirim geri dönüşü eklendi.
- Güncelleme bildirimi aynı sürüm için bir uygulama oturumunda yalnızca bir kez gösterilir.

## 1.1.0 — 10 Temmuz 2026

### Yeni

- Menü çubuğundan aşağı çekilen fizik tabanlı halat zamanlayıcı
- Önemli, Bugün ve Bir Ara görev kategorileri
- Görev başına alarm, tamamlanma ve arşiv akışı
- İsteğe bağlı yerel parola kilidi
- Aynı ağdaki telefonlar için tek kullanımlık QR eşleştirmesi
- İsteğe bağlı Cloudflare relay, WebSocket ve Web Push desteği
- Hermes ve terminal iş akışları için komut satırı köprüsü
- İmzalı güncelleme manifesti ve universal macOS yayın süreci

### İyileştirildi

- Halat overlay'i macOS'ta non-activating panel olarak çalışır; aktif uygulamanın menü çubuğunu devralmaz.
- Overlay ekranın çalışma alanına sınırlandırıldı; menü çubuğu ve Dock görünür kalır.
- Halat başlangıcındaki boşluk kaldırıldı ve çizgi tepsi simgesinin hemen altına bağlandı.
- Alarm penceresi, görev listesi ve bağlantı ekranlarının erişilebilirlik açıklamaları geliştirildi.

### Güvenlik

- Electron renderer süreçleri sandbox, context isolation ve kapalı Node entegrasyonuyla çalışır.
- Yerel parola `scrypt` ile türetilmiş kayıt olarak tutulur; düz metin parola saklanmaz.
- Eşleştirme bağlantıları tek kullanımlıdır ve 10 dakika sonra geçersiz olur.
- Yayın paketleri gömülü anahtar ve hassas değerler için taranır.
