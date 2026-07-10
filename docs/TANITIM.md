# GuruTime — Türkçe Tanıtım Metinleri

## GitHub kısa açıklaması

macOS menü çubuğunda yaşayan, yerel çalışan görev, alarm ve halat zamanlayıcı uygulaması.

## Tek cümlelik tanıtım

GuruTime, görevlerinizi Mac'inizde tutan ve menü çubuğundan çektiğiniz görsel bir halatla saniyeler içinde alarm kurmanızı sağlayan açık kaynak bir macOS uygulamasıdır.

## Kısa tanıtım

GuruTime, yapılacaklar listenizi ve alarmlarınızı macOS menü çubuğuna taşır. Görevleri Önemli, Bugün ve Bir Ara kategorilerinde düzenleyebilir, her göreve alarm ekleyebilir veya menü çubuğundaki simgeyi aşağı çekerek doğrudan yeni bir hatırlatıcı oluşturabilirsiniz. Temel özellikler internet bağlantısı olmadan çalışır ve veriler varsayılan olarak Mac'inizde kalır.

## Ayrıntılı tanıtım

GuruTime, görev yönetimini ayrı bir pencereyi sürekli açık tutmadan kullanmak isteyen macOS kullanıcıları için geliştirildi. Uygulama menü çubuğunda sessizce bekler; görev listenize ulaşmak için simgeye tıklamanız yeterlidir.

Uygulamanın ayırt edici özelliği halat zamanlayıcıdır. Menü çubuğundaki GuruTime simgesini aşağı doğru çektiğinizde ekranda fizik tabanlı bir halat belirir. Halatı bıraktığınız mesafe alarm süresini belirler. Ardından görev adını ve kategorisini girerek hatırlatıcıyı tamamlayabilirsiniz. Halat overlay'i aktif uygulamanın menü çubuğunu devralmaz, sistem arayüzünü kapatmaz ve simgeyle arasında boşluk bırakmaz.

Görevler Önemli, Bugün ve Bir Ara başlıklarında düzenlenir. Her görev tamamlanabilir, arşivlenebilir, geri getirilebilir veya silinebilir. Alarm zamanı geldiğinde GuruTime görsel ve sesli bildirim sunar. Gizliliğe ihtiyaç duyan kullanıcılar isteğe bağlı yerel parola kilidini etkinleştirebilir.

Telefon bağlantısı zorunlu değildir. İsteyen kullanıcılar aynı ağdaki bir telefonu tek kullanımlık QR kodla eşleştirebilir. Cloudflare relay kurulumu ise uçtan uca şifreli komut aktarımı, uzaktan bağlantı ve ikincil Web Push bildirimi sağlar. QR bağlantıları 10 dakika içinde geçersiz olur ve bağlı cihazlar ayrı ayrı iptal edilebilir.

GuruTime'ın temel görev ve alarm akışı tamamen yerel çalışır. Uygulama Electron güvenlik sınırları, kısıtlı IPC kanalları, `scrypt` tabanlı parola kaydı, kısa ömürlü eşleştirme anahtarları ve yayın öncesi gizli değer taramasıyla güvenli varsayılanlar kullanır.

## Öne çıkan özellikler

- macOS menü çubuğundan hızlı erişim
- Fizik tabanlı, aşağı çekilen halat zamanlayıcı
- Önemli, Bugün ve Bir Ara görev kategorileri
- Görev bazlı alarm, tamamlama ve arşivleme
- İnternet olmadan çalışan local-first mimari
- İsteğe bağlı yerel parola kilidi
- Tek kullanımlık QR ile telefon eşleştirme
- İsteğe bağlı Cloudflare relay ve Web Push
- Terminal ve otomasyonlar için CLI köprüsü
- Apple Silicon ve Intel için universal macOS paketleme

## Sosyal paylaşım metni

GuruTime'ın yeni sürümü hazır: macOS menü çubuğunda yaşayan, tamamen yerel çalışabilen görev ve alarm uygulaması. Menü çubuğundaki simgeyi aşağı çekerek görsel halat üzerinden saniyeler içinde hatırlatıcı kurabilir, görevlerinizi kategorilere ayırabilir ve isterseniz telefonunuzu tek kullanımlık QR ile eşleştirebilirsiniz. Proje açık kaynak ve MIT lisanslıdır.

## Güvenlik ve gizlilik özeti

GuruTime görevleri ve alarmları varsayılan olarak kullanıcının Mac'inde saklar. Bulut bağlantısı kapalı gelir ve isteğe bağlıdır. Yerel parola düz metin olarak tutulmaz. Telefon eşleştirme kodları kısa ömürlü ve tek kullanımlıdır. Uygulama renderer süreçleri doğrudan Electron veya Node erişimine sahip değildir.
