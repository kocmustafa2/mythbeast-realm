/* Mythbeast Realm — ORTAK KURALLAR
   Oyun (tarayıcı, globalThis.MR) ve sunucu (src/worker.js, import) aynı dosyayı kullanır.
   Kartlar, paket olasılıkları, evrim, sandık, görev, hediye, lig ve savaş ödülleri BURADA.
   Ekonomi işlemleri act(st, a, p, ctx) ile yapılır; rastgelelik ctx.rng ile gelir.
   Sunucu sürümünde ctx.rng kriptografik, artifact içinde Math.random. */
(function (G) {
'use strict';
const ELS=['fire','water','earth','air','light','shadow','metal','poison'];   // 12'ye çıkacak: yeni türü T'ye ve TYPES'a eklemek yeterli

const round5=x=>Math.max(5,Math.round(x/5)*5);

const RAR=[
  {n:'Yaygın',  sym:'●',hp:100,mult:1.00,team:2,ret:1,dust:5,  craft:40},
  {n:'Nadir',   sym:'◆',hp:140,mult:1.15,team:3,ret:1,dust:20, craft:150},
  {n:'Destansı',sym:'★',hp:185,mult:1.30,team:4,ret:2,dust:80, craft:500},
  {n:'Efsanevi',sym:'★',hp:225,mult:1.40,team:5,ret:2,dust:300,craft:1600}
];
const TYPE_HP={fire:0,water:0,earth:15,air:-15,light:0,shadow:-15,metal:15,poison:-5,blood:0};   // Toprak dayanıklı, Hava kırılgan
const TYPE_RET={fire:0,water:0,earth:1,air:-1,light:0,shadow:-1,metal:1,poison:0,blood:0};    // Toprak ağır, Hava hafif
const DMG=[0,20,45,75,110];                        // (eski enerji eğrisi, artık kullanılmıyor)
// SALDIRI DEĞERLERİ: [normal, dolu] × nadirlik (Yaygın, Nadir, Destansı, Efsanevi)
const ATK=[[30,40,50,60],[55,70,90,110]];
const FXV={burn:20,splash:20,heal:30,coin:20,recoil:30};   // efekt büyüklükleri
const FX={
  burn:  {cost:5,  t:'Vurulan kart yanar: sahibinin sonraki 2 turunun başında 20 hasar alır.'},
  splash:{cost:5,  t:'Rakibin sahadaki diğer kartlarına da 20 hasar.'},
  heal:  {cost:5,  t:'Bu kart 30 can yeniler.'},
  coin:  {cost:5,  t:'Yazı-tura at. Tura gelirse +20 hasar.'},
  recoil:{cost:-15,t:'Bu kart kendine 30 hasar verir.'}
};
const round10=x=>Math.max(10,Math.round(x/10)*10);
const atkDmg=(r,i,fx)=>Math.max(10,round5(ATK[i][r]-(fx?FX[fx].cost:0)));
const PACK={cost:100,pity:60,
  slots:[[85,13,2,0],[85,13,2,0],[85,13,2,0],[0,82.4,17,0.6],[0,66.5,32,1.5]]};  // her slot: Yaygın/Nadir/Destansı/Efsanevi %
const XP={card:[2,5,12,30],newMult:2,need:l=>50+(l-1)*25,reward:{free:1,gold:50}};  // seviye sistemi
const ECON={startGold:700,freePacks:5,win:150,loss:20,teamMax:10};

const RAW=[
 [1,'Korkuyruk','fire',0,0,0,0,1,'tl',[[1,'Kıvılcım'],[2,'Alev Kuyruk']],'Kuyruğundaki kor sönerse hemen uykuya dalar.'],
 [2,'Alevpençe','fire',1,1,1,0,1,'tlsh',[[2,'Pençe Darbesi'],[3,'Yakıcı Hamle','burn']],'Pençelerinin değdiği taş kıpkırmızı kesilir.'],
 [3,'Volkanor','fire',2,2,2,10,2,'tshw',[[2,'Lav Tükürüğü','burn'],[4,'Patlama','recoil']],'Öfkelendiğinde sırtındaki kraterler bir bir patlar.'],
 [4,'Kıvılcık','fire',0,0,0,-10,0,'c',[[1,'Atılma','coin'],[2,'Ateş Topu']],'Mutlu olunca etrafa kıvılcım saçar.'],
 [5,'Kıvılkurt','fire',1,1,4,0,1,'lct',[[1,'Isırık'],[3,'Ateş Çemberi','splash']],'Sürü halinde avlanır, geçtiği yerde iz kalır.'],
 [6,'Kül Böceği','fire',0,0,0,0,0,'sl',[[2,'Kül Bulutu','burn']],'Sönmüş volkanların içinde yaşar.'],
 [7,'Anka','fire',3,0,0,0,0,'wkct',[[2,'Kanat Rüzgârı'],[4,'Küllerden Doğuş','heal']],'Her yüz yılda bir yanar ve küllerinden yeniden doğar.'],
 [8,'Damlacık','water',0,0,0,0,0,'f',[[1,'Su Fışkırtma'],[2,'Dalga']],'Yağmurlu günlerde su birikintilerinde oynar.'],
 [9,'Dalgakuyruk','water',1,1,8,0,1,'ft',[[2,'Su Kırbacı'],[3,'Gelgit','heal']],'Kuyruğunu çarpınca küçük dalgalar yaratır.'],
 [10,'Derinyüzgeç','water',2,2,9,0,1,'fts',[[3,'Girdap'],[4,'Tsunami','splash']],'Okyanusun en karanlık yerinde nöbet tutar.'],
 [11,'Kabukçuk','water',0,0,0,10,1,'sl',[[1,'Kıskaç'],[2,'Kabuk Kalkanı','heal']],'Korkunca kabuğuna çekilip saatlerce çıkmaz.'],
 [12,'Mercankale','water',1,1,11,20,0,'slh',[[2,'Sıkıştır'],[3,'Mercan Çarpması']],'Sırtındaki mercanlarda küçük balıklar yaşar.'],
 [13,'Köpük Balığı','water',0,0,0,-10,1,'f',[[2,'Kabarcık Yağmuru','coin']],'Şişince iki katı büyüklüğe ulaşır.'],
 [14,'Okyanus Ejderi','water',3,0,0,10,1,'fhst',[[3,'Su Topu'],[4,'Derinlerin Gazabı']],'Denizciler onu yalnızca fırtınalı gecelerde görür.'],
 [15,'Filizcik','earth',0,0,0,0,0,'c',[[1,'Yaprak'],[2,'Kök Kırbacı']],'Güneşli bir köşede saatlerce hareketsiz durur.'],
 [16,'Dalbaşı','earth',1,1,15,0,2,'ch',[[2,'Diken Atışı'],[3,'Ağaç Darbe']],'Başındaki dallar her bahar yeniden çiçek açar.'],
 [17,'Ormanyürek','earth',2,2,16,0,2,'hcs',[[3,'Kök Ağı','heal'],[4,'Orman Gazabı']],'Kökleri bütün ormanın altına uzanır.'],
 [18,'Taşkirpi','earth',0,0,0,0,0,'sl',[[1,'Yuvarlan'],[2,'Dikenler','coin']],'Top gibi yuvarlanıp yokuş aşağı iner.'],
 [19,'Kayakabuk','earth',1,1,18,10,0,'slh',[[2,'Sertleş','heal'],[3,'Kaya Çarpması']],'Kabuğu kayalardan bile serttir.'],
 [20,'Yosun Ayısı','earth',0,0,0,10,2,'lc',[[2,'Yumruk']],'Kış uykusunda üstünü yosun kaplar.'],
 [21,'Dağ Devi','earth',3,0,0,10,2,'sh',[[3,'Deprem','splash'],[4,'Dağ Yumruğu']],'Uyuduğunda insanlar onu bir tepe sanır.'],
 [22,'Serçecik','air',0,0,0,0,0,'wk',[[1,'Gagala'],[2,'Kanat Vuruşu']],'Sabahları ilk ötüşüyle rüzgârı uyandırır.'],
 [23,'Rüzgârkanat','air',1,1,22,0,0,'wkt',[[1,'Hızlı Dalış'],[3,'Hortum','splash']],'Bulutların üstünde günlerce süzülebilir.'],
 [24,'Fırtınagöz','air',2,2,23,0,0,'wktc',[[2,'Şimşek','coin'],[4,'Kasırga']],'Gözlerini açtığında gökyüzü kararır.'],
 [25,'Bulutçuk','air',0,0,0,0,0,'l',[[1,'Pofuduk','heal'],[2,'Esinti']],'Dokunanlar onu pamuk sanar.'],
 [26,'Bulutkoyun','air',1,1,25,0,0,'lc',[[2,'Yumuşak Çarpma','heal'],[3,'Gök Gürültüsü']],'Yünü yağmur bulutuna dönüşebilir.'],
 [27,'Esinti Yarasası','air',0,0,0,0,0,'w',[[1,'Ultrason','coin'],[2,'Kanat Kesiği']],'Karanlıkta sesleriyle yolunu bulur.'],
 [28,'Gök Ejderi','air',3,0,0,0,1,'whst',[[2,'Rüzgâr Kesiği'],[4,'Gökyüzü Öfkesi','coin']],'Kanat çırptığında kıtalar arası rüzgâr eser.'],
 [29,'Işıltık','light',0,0,0,0,0,'c',[[1,'Parıltı'],[2,'Işık Oku']],'Karanlık odalarda küçük bir yıldız gibi parlar.'],
 [30,'Şafakkanat','light',1,1,29,0,0,'wc',[[2,'Şafak Rüzgârı'],[3,'Kutsal Işın','heal']],'Her sabah güneşle birlikte gökyüzüne yükselir.'],
 [31,'Güneşmuhafız','light',2,2,30,10,2,'whc',[[2,'Işık Kalkanı','heal'],[4,'Güneş Patlaması','splash']],'Tapınakların kapısında yüzyıllardır nöbet tutar.'],
 [32,'Fenerböceği','light',0,0,0,-10,0,'wl',[[1,'Göz Kamaştır','coin'],[2,'Işık Topu']],'Kayıp yolculara geceleri yol gösterir.'],
 [33,'Şafak Geyiği','light',3,0,0,0,1,'hl',[[3,'Kuzey Işığı'],[4,'Göksel Hüküm','heal']],'Boynuzlarından süzülen ışık kuzey göğünü boyar.'],
 [34,'Gölgecik','shadow',0,0,0,0,0,'c',[[1,'Gizlen','coin'],[2,'Karanlık Pençe']],'Sadece göz ucuyla bakınca görülebilir.'],
 [35,'Gecekedi','shadow',1,1,34,0,1,'tlc',[[2,'Sinsi Atak'],[3,'Gölge Darbesi','coin']],'Ay ışığında adım sesi bile çıkarmadan dolaşır.'],
 [36,'Gecehükmü','shadow',2,2,35,10,2,'hwt',[[3,'Kâbus','splash'],[4,'Karanlık Dalga','recoil']],'Uyuyanların rüyalarına girip kâbusa çevirir.'],
 [37,'Sisruh','shadow',0,0,0,0,2,'c',[[1,'Ürküt'],[2,'Sis Perdesi','heal']],'Sisli gecelerde mezarlıkların üstünde süzülür.'],
 [38,'Tutulma Kurdu','shadow',3,0,0,0,1,'lth',[[2,'Ay Işığı Isırığı'],[4,'Tam Tutulma','coin']],'Uluduğunda ay bir anlığına kararır.'],
 [39,'Közkuzu','fire',0,0,0,10,0,'lc',[[1,'Sıcak Toslama'],[2,'Kor Yünü','burn']],'Yünü kışın bütün köyü ısıtır.'],
 [40,'Lavkoç','fire',1,1,39,10,0,'lh',[[2,'Boynuz Darbesi'],[3,'Lav Hücumu','recoil']],'Boynuzlarından damlayan lav taşları eritir.'],
 [41,'Kıvılcım Yılanı','fire',0,0,0,-10,1,'t',[[1,'Isırık'],[2,'Alev Dili','burn']],'Kumların altında sıcak bir iz bırakarak süzülür.'],
 [42,'Mürekkepçik','water',0,0,0,0,0,'f',[[1,'Mürekkep Püskürt','coin'],[2,'Dokunaç']],'Korkunca mavi mürekkep bulutunun içinde kaybolur.'],
 [43,'Derinkol','water',1,1,42,10,0,'ft',[[2,'Sıkıştır'],[3,'Derin Girdap','splash']],'Kolları gemileri sarabilecek kadar uzundur.'],
 [44,'Kar Foku','water',0,0,0,10,1,'f',[[1,'Kaydır'],[2,'Buz Nefesi']],'Buzulların üstünde karnı üstünde kayarak oynar.'],
 [45,'Mantarcık','earth',0,0,0,0,2,'c',[[1,'Spor Bulutu','heal'],[2,'Kafa Atma']],'Yağmurdan sonra bir gecede ortaya çıkar.'],
 [46,'Mantarbey','earth',1,1,45,10,2,'cl',[[2,'Zehirli Spor','burn'],[3,'Mantar Yumruğu']],'Ormanın en yaşlı ağaçlarının dibinde yaşar.'],
 [47,'Mantar Kral','earth',2,2,46,10,2,'chl',[[2,'Kraliyet Sporu','heal'],[4,'Orman Hükmü','splash']],'Kabuğunun üstünde koca bir mantar ormanı taşır.'],
 [48,'Toprakkazan','earth',0,0,0,10,1,'l',[[1,'Kaz'],[2,'Tünel Saldırısı','coin']],'Bir gecede tepenin altından tünel açabilir.'],
 [49,'Tüycük','air',0,0,0,-10,0,'c',[[1,'Uçuş'],[2,'Esinti','heal']],'Rüzgâr nereye eserse oraya gider.'],
 [50,'Gökdenizanası','air',1,1,49,0,2,'c',[[2,'Hava Akımı'],[3,'Dokunaç Rüzgârı','coin']],'Bulutların arasında denizdeymiş gibi süzülür.'],
 [51,'Fırtına Denizanası','air',2,2,50,0,2,'ch',[[2,'Şimşek Dokunacı'],[4,'Fırtına Çağrısı','splash']],'Dokunaçlarından yere şimşekler iner.'],
 [52,'Süzülen Sincap','air',0,0,0,0,0,'tl',[[1,'Atlayış'],[2,'Süzülme Darbesi']],'Ağaçtan ağaca kanatsız süzülür.'],
 [53,'Kristalcik','light',0,0,0,0,0,'s',[[1,'Parıldama'],[2,'Kristal Oku']],'İçinden geçen ışığı yedi renge böler.'],
 [54,'Kristal Kanat','light',1,1,53,0,0,'ws',[[2,'Kırılan Işık'],[3,'Prizma Işını','coin']],'Kanatları gün ışığında gökkuşağı saçar.'],
 [55,'Prizma Ejderi','light',2,2,54,10,1,'wsh',[[2,'Işık Kalkanı','heal'],[4,'Gökkuşağı Nefesi','splash']],'Nefesi karanlık mağaraları gün gibi aydınlatır.'],
 [56,'Mumcuk','light',0,0,0,-10,2,'c',[[1,'Titrek Alev'],[2,'Sıcak Işık','heal']],'Rüzgârda sönmeyen tek mum onun başındakidir.'],
 [57,'Işıkbalığı','light',0,0,0,0,1,'f',[[1,'Işık Yanıp Sönme'],[2,'Parlak Dalga']],'Gece denizinde parlayan iz bırakır.'],
 [58,'Prizmabalığı','light',1,1,57,0,1,'fs',[[2,'Pul Yağmuru'],[3,'Işık Dalgası','splash']],'Pulları güneşte binlerce renge döner.'],
 [59,'Ağcık','shadow',0,0,0,0,0,'l',[[1,'Ağ At'],[2,'Zehirli Isırık','burn']],'Köşelerde görünmez ağlar örer.'],
 [60,'Gece Örümceği','shadow',1,1,59,0,0,'ls',[[2,'Ağ Tuzağı'],[3,'Gölge Ağı','splash']],'Ağları ay ışığında bile görünmez.'],
 [61,'Kâbus Örümceği','shadow',2,2,60,10,2,'lsh',[[2,'Korku Ağı','burn'],[4,'Kâbus Isırığı','recoil']],'Ağına düşen rüyasında bile kaçamaz.'],
 [62,'Gece Baykuşu','shadow',0,0,0,0,0,'wk',[[1,'Sessiz Pençe'],[2,'Gece Bakışı','coin']],'Gözleri karanlıkta iki ay gibi parlar.'],
 [63,'Hilal Baykuşu','shadow',1,1,62,0,0,'wkc',[[2,'Hilal Kanat'],[3,'Ay Tutulması','burn']],'Kanatlarını açtığında gökyüzünde hilal belirir.'],
 [64,'Kuzgun Ruhu','shadow',0,0,0,-10,0,'wk',[[1,'Gaga Darbesi'],[2,'Uğursuz Çığlık','coin']],'Ortaya çıktığı yerde ışıklar titrer.'],
 // ---- Seri 1 tamamlama: tek aşamalı Yaygın kartların evrimleri (Nadir) ----
 [71,'Magmakanat','fire',1,1,6,10,0,'wsl',[[1,'Kor Kanat'],[3,'Magma Boynuzu','burn']],'Kabuğu açılınca lav rengi kanatları gökyüzünü aydınlatır.'],
 [72,'Dalgadiken','water',1,1,13,0,1,'fs',[[1,'Diken Fırlat'],[3,'Girdap Kalkanı','coin']],'Etrafında dönen akıntılar onu zırh gibi korur.'],
 [73,'Kökpençe','earth',1,1,20,20,2,'lc',[[2,'Kök Yumruğu'],[3,'Orman Gazabı','heal']],'Sırtındaki fidan her bahar biraz daha büyür.'],
 [74,'Yankıkanat','air',1,1,27,-10,0,'w',[[1,'Ses Dalgası'],[3,'Yankı Fırtınası','splash']],'Çığlığı kristal mağaraların duvarlarını titretir.'],
 [75,'Yıldızfener','light',1,1,32,0,0,'wl',[[1,'Işık Huzmesi'],[3,'Yıldız Patlaması','splash']],'Geceleri kuyruğu bir yıldız gibi parlar.'],
 [76,'Siskral','shadow',1,1,37,0,0,'c',[[1,'Sis Pençesi'],[3,'Pus Hükmü','burn']],'Kristal tacı sisli mezarlığın kralı olduğunu gösterir.'],
 [77,'Korkobra','fire',1,1,41,0,1,'t',[[1,'Kor Isırık'],[3,'Alev Nefesi','burn']],'Başlığını açtığında çöl gecesi bile ısınır.'],
 [78,'Buzdişi','water',1,1,44,20,1,'f',[[2,'Buz Dişi'],[3,'Kuzey Fırtınası','recoil']],'Buz kristali dişleri hiç erimez.'],
 [79,'Kazmapençe','earth',1,1,48,10,0,'lc',[[1,'Kazı'],[3,'Kristal Kazma','coin']],'Kaskındaki kristal ışığıyla yerin altını aydınlatır.'],
 [80,'Bulutsüzen','air',1,1,52,-10,0,'wt',[[1,'Rüzgâr Süzülüşü'],[3,'Bulut Kasırgası','coin']],'Boynundaki bulut atkısıyla saatlerce süzülür.'],
 [81,'Şamdanruh','light',1,1,56,0,2,'c',[[1,'Mum Işığı'],[3,'Üçlü Alev','heal']],'Üç alevi asla aynı anda sönmez.'],
 [82,'Gölgekuzgun','shadow',1,1,64,-10,0,'wk',[[1,'Gölge Gaga'],[3,'Ay Tutulması Çığlığı','splash']],'Kanat çırptığında tüyleri dumana dönüşür.'],
 // ===================== SERİ 2: METAL ve ZEHİR =====================
 [86,'Pasçık','metal',0,0,0,0,0,'s',[[1,'Diken Batır'],[2,'Pas Yuvarlanması','coin']],'Paslı dikenlerini her sabah demirci ateşinde ısıtır.'],
 [87,'Demirkirpi','metal',1,1,86,0,0,'sl',[[1,'Çivi Yağmuru'],[3,'Kıvılcım Topu','splash']],'Dikenlerinin arasında mavi kıvılcımlar çakar.'],
 [88,'Çelikkale','metal',2,2,87,20,0,'sl',[[2,'Kalkan Darbesi'],[4,'Kale Yıkımı','recoil']],'Sırtındaki küçük kulelerde serçeler yaşar.'],
 [89,'Teneke Serçe','metal',0,0,0,-10,0,'w',[[1,'Gaga Vuruşu'],[2,'Kurmalı Dalış']],'Sırtındaki anahtarı kurulunca bütün gün öter.'],
 [90,'Bıçakkanat','metal',1,1,89,-10,0,'w',[[1,'Kanat Kesiği'],[3,'Bıçak Fırtınası','splash']],'Tüyleri gün ışığında ayna gibi parlar.'],
 [91,'Kılıçkartal','metal',2,2,90,0,0,'wt',[[2,'Çelik Pençe'],[4,'Kılıç Kasırgası','coin']],'Kanatlarındaki her tüy bir kılıçtır.'],
 [92,'Çancık','metal',0,0,0,0,1,'c',[[1,'Tını'],[2,'Çan Sesi','coin']],'Her adımda küçük bir çan sesi duyulur.'],
 [93,'Çanruh','metal',1,1,92,0,1,'c',[[1,'Ses Dalgası'],[3,'Kutsal Çan','heal']],'Manastırın çan kulesinde yüzyıllardır yaşar.'],
 [94,'Gong Lordu','metal',2,2,93,20,2,'lc',[[2,'Tokmak'],[4,'Dev Gong','splash']],'Gongunu bir kez çaldığında dağlar yankılanır.'],
 [95,'Kıskaçcık','metal',0,0,0,0,1,'l',[[1,'Mıknatıs Kıskaç'],[2,'Somun Atışı','coin']],'Kumsalda bulduğu vidaları toplamayı sever.'],
 [96,'Demirkıskaç','metal',1,1,95,20,1,'l',[[2,'Çelik Kıskaç'],[3,'Manyetik Fırtına','splash']],'Fırtınalı gecelerde deniz fenerini korur.'],
 [97,'Kılıç Aslanı','metal',3,0,0,0,0,'lt',[[3,'Kılıç Yelesi'],[4,'Bin Kılıç','splash']],'Yelesindeki kılıçlar düşen kahramanlardan kalmadır.'],
 [98,'Fokurcuk','poison',0,0,0,-10,1,'f',[[1,'Asit Baloncuğu'],[2,'Zehirli Sıçrama','burn']],'Bataklığın en sevimli ama en zehirli iribaşı.'],
 [99,'Asit Kurbağa','poison',1,1,98,0,0,'l',[[1,'Dil Kamçısı'],[3,'Asit Tükürüğü','burn']],'Sırtındaki kabarcıklar patladığında etrafa asit saçar.'],
 [100,'Bataklık Kralı','poison',2,2,99,20,0,'lc',[[2,'Kral Gırtlağı'],[4,'Zehir Seli','splash']],'Bataklığın taşlarından yapılmış tahtında oturur.'],
 [101,'Dikencik','poison',0,0,0,-10,1,'s',[[1,'Diken Batır'],[2,'Zehirli Isırık','burn']],'Yaprakların üstünde yavaşça ama kararlı ilerler.'],
 [102,'Kükürt Kozası','poison',1,1,101,10,1,'s',[[1,'Buhar'],[3,'Kükürt Bulutu','burn']],'İçinde uyurken etrafına zehirli sis yayar.'],
 [103,'Kükürt Güvesi','poison',2,2,102,-10,0,'w',[[2,'Toz Kanat'],[4,'Zehir Fırtınası','splash']],'Kanatlarındaki gözler düşmanlarını korkutur.'],
 [104,'Akrepçik','poison',0,0,0,0,0,'lt',[[1,'Kıskaç'],[2,'İğne','burn']],'Kuyruğundaki tek damla zehirle gurur duyar.'],
 [105,'Asit Akrep','poison',1,1,104,0,0,'lt',[[1,'Çelik Kıskaç'],[3,'Asit İğnesi','burn']],'Kanyonun asit havuzlarında avlanır.'],
 [106,'Ölümkuyruk','poison',2,2,105,10,0,'lt',[[2,'Kristal İğne'],[4,'Ölüm Darbesi','recoil']],'Antik çöl tapınağının bekçisidir.'],
 [107,'Sporcuk','poison',0,0,0,0,2,'c',[[1,'Spor Püskürt'],[2,'Mantar Tozu','coin']],'Utangaçtır, korkunca etrafa spor saçar.'],
 [108,'Sporbulut','poison',1,1,107,10,2,'c',[[2,'Zehirli Spor'],[3,'Spor Bulutu','splash']],'Ormanın en derin yerinde dev mantarların arasında yaşar.'],
 [109,'Bataklık Hidrası','poison',3,0,0,0,0,'lt',[[3,'Üçlü Isırık'],[4,'Asit Gölü','burn']],'Üç başından biri hep uyanıktır.'],
];
const E1=[1,2,2,3],E2=[2,3,4,4];   // Yaygın, Nadir, Destansı, Efsanevi
const CARDS=RAW.map(([id,name,el,r,stage,from,hpMod,b,f,atks,flv])=>({id,name,el,r,stage,from,b,f,flv,
  hp:RAR[r].hp+TYPE_HP[el]+hpMod*2+(atks.length<2?30:0),   // tek saldırılı kart doldurma yapamaz: +20 can
  ret:Math.max(0,RAR[r].ret+TYPE_RET[el]),
  // enerji nadirlikten gelir: ilk saldırı E1, ikinci (güçlü) saldırı E2 → evrimli kart her zaman daha sert vurur
  atks:atks.map(([e0,n,fx],i)=>{const e=i===0?E1[r]:E2[r];return{e,name:n,fx,dmg:atkDmg(r,i,fx)}})}));
const BY=Object.fromEntries(CARDS.map(c=>[c.id,c]));
const rootOf=c=>c.from?rootOf(BY[c.from]):c;
const N=CARDS.length;
const pad=n=>String(n).padStart(3,'0');
const setOf=c=>c.id>=86&&c.id<=109?2:1;
const setCards=n=>CARDS.filter(c=>setOf(c)===n);
const cno=c=>{const i=setCards(setOf(c)).indexOf(c);return pad(i>=0?i+1:c.id)};
const setN=c=>setCards(setOf(c)).length;   // kart numarası: seri içindeki sıra (yeni eklenenler sona)

const EXA={blast:'Sahaya inince bütün rakiplere 20 hasar',heal:'Sahaya inince kendi kartlarına +30 can, kötü etkileri siler',stand:'Yenilmeden önce bir kez 50 canla ayağa kalkar'};
const EXCOST={copies:3,dust:1500};
const EXD=[[65,7,'Buz Ankası','water','blast',['Buz Tüyü'],['Donduran Fırtına','splash'],'Alevleri söndüğünde buzdan yeniden doğdu.'],
 [66,14,'Altın Deniz Ejderi','light','heal',['Altın Dalga'],['Güneş Gelgiti','heal'],'Gün batımında denizi altına boyar.'],
 [67,21,'Kristal Dev','shadow','stand',['Kristal Yumruk'],['Ametist Çığ','burn'],'Dağın kalbindeki kristaller onu uyandırdı.'],
 [68,28,'Fırtına Ejderi','air','blast',['Şimşek Pençe'],['Gök Gürültüsü','splash'],'Kanat çırptığında gök yarılır.'],
 [69,33,'Gül Geyiği','light','heal',['Çiçek Işığı'],['Gül Aurorası','heal'],'Geçtiği yerde karın üstünde çiçekler açar.'],
 [70,38,'Kızıl Ay Kurdu','fire','stand',['Kor Diş'],['Kızıl Tutulma','burn'],'Kızıl ay doğduğunda uluması dağları titretir.']];
const EXC=EXD.map(([id,base,name,el,exa,a1,a2,flv])=>{const B0=BY[base];return{id,base,name,el,exa,flv,ex:1,r:3,stage:0,from:0,b:B0.b,f:B0.f,ret:B0.ret,hp:260,
  atks:[{e:E1[3],name:a1[0],fx:a1[1],dmg:Math.max(10,round5(70-(a1[1]?FX[a1[1]].cost:0)))},{e:E2[3],name:a2[0],fx:a2[1],dmg:Math.max(10,round5(125-(a2[1]?FX[a2[1]].cost:0)))}]}});
EXC.forEach(c=>BY[c.id]=c);
const exOf=c=>EXC.find(x=>x.base===c.id);

const EZA={drain:'Sahadayken her tur rakibin bütün kartlarından 50 can çeker ve kendini iyileştirir'};const EZDR=50;
const EZC=[[83,'Ezelhan','blood','drain',['Kıyamet Pençesi'],['Tutulma Nefesi','burn'],'Dünyanın başlangıcından önce vardı; altı türü yuttu ve gökyüzünü kararttı.',0,'whts'],
 [84,'Ölüağaç','blood','drain',['Kemik Dal'],['Çürüyen Orman','splash'],'Bastığı yerde orman küle döner; boynuzlarındaki fenerler kayıp ruhları taşır.',1,'l'],
 [85,'Boşgöz','blood','drain',['Boşluk Bakışı'],['Göğün Yarığı','splash'],'Gökyüzündeki yarığın ardından dünyayı izleyen tek göz.',0,'c']].map(([id,name,el,exa,a1,a2,flv,b,f])=>({id,name,el,exa,flv,ex:1,ez:1,r:3,stage:0,from:0,b,f,ret:2,hp:500,
  atks:[{e:E1[3],name:a1[0],dmg:400},{e:E2[3],name:a2[0],fx:a2[1],dmg:400}]}));
EZC.forEach(c=>BY[c.id]=c);

const POOL=[0,1,2,3].map(r=>CARDS.filter(c=>c.r===r));
const POOLS={1:[0,1,2,3].map(r=>CARDS.filter(c=>c.r===r&&setOf(c)===1)),2:[0,1,2,3].map(r=>CARDS.filter(c=>c.r===r&&setOf(c)===2))};
const EVO_NEED={1:10,2:20};               // evrim bedeli: temel karttan kaç kopya
const STAGE_W=[1,0.08,0.02];               // paketten çıkma ağırlığı: Temel 1, Evrim 1 çok nadir, Evrim 2 aşırı nadir
const cw=c=>c.r===3?1:STAGE_W[c.stage];

const SHINY={chance:.015};

const LEAGUES=[
  {n:'Bronz',  min:0,   col:'#c98a54',up:0,   down:.35,mis:.45,gold:0, reward:0},
  {n:'Gümüş',  min:200, col:'#c7d2da',up:0,   down:.15,mis:.30,gold:10,reward:1},
  {n:'Altın',  min:500, col:'#f5c451',up:.10, down:0,  mis:.18,gold:20,reward:2},
  {n:'Elmas',  min:900, col:'#7fd8ff',up:.25, down:0,  mis:.10,gold:35,reward:3},
  {n:'Usta',   min:1400,col:'#c27bff',up:.40, down:0,  mis:.05,gold:50,reward:4},
  {n:'Efsane', min:2000,col:'#ff6a5a',up:.55, down:0,  mis:0,  gold:70,reward:5}
];
const TROPHY={win:30,loss:-18,floorStep:true};   // lig tabanının altına düşülmez
// galibiyet serisi: 2. galibiyetten itibaren ek kupa/altın (4'te sabitlenir)
const STREAK={tr:[0,0,5,10,15],gold:[0,0,10,20,30]};
const strkB=n=>{const k=Math.min(n,4);return{tr:STREAK.tr[k],g:STREAK.gold[k]}};
// zafer sandığı: her 3 galibiyette 1 sandık; içerik lige göre artar
const CHEST={need:3,gold:l=>50+l*15,dust:l=>10+l*5,card:[70,25,4.6,0.4],pack:.10};

const lgOf=t=>{let i=0;LEAGUES.forEach((l,k)=>{if(t>=l.min)i=k});return i};

const GIFT={every:6*3600e3,max:2};

const DQP=[
  {t:'pack',n:2,g:60,d:0},
  {t:'battle',n:3,g:50,d:0},
  {t:'win',n:2,g:80,d:0},
  {t:'hit',n:8,g:60,d:0,el:1},
  {t:'weak',n:5,g:50,d:15},
  {t:'ko',n:8,g:60,d:0},
  {t:'adv',n:1,g:70,d:10}];
const DQB={free:1};

function srnd(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

const SUPK=['fire','water','earth','air','light','shadow','metal','poison','evo'];

const ADV_CH=[['fire','Kor Dağları'],['water','Mercan Denizi'],['earth','Kadim Orman'],['air','Bulut Zirvesi'],['light','Işık Tapınağı'],['shadow','Gece Diyarı']];
const ADV_RULE={none:['Normal savaş',''],hp:['Dayanıklı rakip','Rakip kartları %20 fazla canla başlar'],first:['Pusu','Rakip ilk saldırır'],charged:['Hazırlıklı rakip','Rakip kartları dolu başlar'],burn:['Kızgın zemin','Senin kartların yanık başlar'],boss:['BOSS','Boss %50 fazla canla ve dolu başlar']};
const ADV_P=10;                       // her diyardaki bölüm sayısı (son bölüm boss)
const ADV_N=ADV_CH.length*ADV_P;
function advStageX(i){const ch=i-100,[el,cn]=ADV_CH[ch],X=EXC[ch],r=srnd(5000+ch*31);
  const pool=CARDS.filter(c=>c.el===el&&c.r>=1&&c.r<3);const deck=[];for(let k=0;k<7;k++)deck.push(pool[Math.floor(r()*pool.length)]);deck[1]=X;deck[4]=BY[X.base];
  return{i,ch,p:ADV_P,el,cn,name:`${X.name} EX`,rule:'boss',deck,boss:X,mis:.04,gold:1200,dust:120,pack:2,x:1}}
function advStage(i){if(i>=100)return advStageX(i);const ch=Math.floor(i/ADV_P),p=i%ADV_P,[el,cn]=ADV_CH[ch],d=i/(ADV_N-1),r=srnd(1000+i*97),last=p===ADV_P-1;
  const rule=last?'boss':['none','hp','first',ch%2?'burn':'charged','none','charged','hp','first',ch%2?'charged':'burn'][p];
  const pool=CARDS.filter(c=>c.el===el&&c.r<3),pk=rr=>{const L=pool.filter(c=>c.r===rr);return (L.length?L:pool)[Math.floor(r()*(L.length||pool.length))]};
  const w=[Math.max(.1,.85-1.1*d),.15+.45*d,Math.max(0,.6*d-.05)];
  const deck=[];for(let k=0;k<7;k++){let x=r()*(w[0]+w[1]+w[2]),rr=x<w[0]?0:x<w[0]+w[1]?1:2;if(p===0&&ch===0)rr=0;deck.push(pk(rr))}
  let boss=null;if(last){boss=CARDS.find(c=>c.el===el&&c.r===3)||pool.sort((a,b)=>b.hp-a.hp)[0];deck[1]=boss}
  // ilk geçiş altını 200'den ~1000'e çıkar; diyar ortasında ve sonunda (boss) 1 paket
  return{i,ch,p,el,cn,name:last?`${boss.name}`:`${cn} ${p+1}`,rule,deck,boss,mis:Math.max(.05,.45-.42*d)-(last?.05:0),gold:Math.round((200+800*d)/10)*10,dust:10+i,pack:last||p===4?1:0}}

const TUT={card:4,evo:5,start:5,perPack:2,packs:3};

const fresh=()=>({gold:ECON.startGold,dust:0,free:ECON.freePacks,owned:{},pity:0,lvl:1,xp:0,trophy:0,bestLg:0,wins:0,losses:0,opened:0,t:0});

/* =====================================================================
   EKONOMİ — sadece bu fonksiyonlar altın, kart, toz, paket vb. değiştirir.
   ===================================================================== */
// Sunucunun sahip olduğu alanlar: istemcinin kaydetme isteği bunları DEĞİŞTİREMEZ.
const ECON_KEYS=['gold','dust','free','owned','shiny','sup','supV','supV2','pity','xp','lvl','opened','trophy','bestLg','wins','losses',
  'streak','lstreak','chest','chests','hist','gift','gt','advC','advV','exB','rqT','dn','dq','rare','tp','uidN','tut','bt','bl',
  'av','bestStk','dnTot','evoN','awkN','ssBest','ach','achC'];
// İstemcinin değiştirebildiği zararsız alanlar (ayarlar, deste seçimi, ipuçları).
const CLIENT_KEYS=['mv','sv','snd','deck','deck2','shOff','pset','th','sid','t'];
const TUT_CLIENT_MAX=2;            // istemci öğreticiyi en fazla bu adıma kendisi ilerletebilir (hoş geldin → paket aç)
const BATTLE_MIN_MS=30000;          // ödül için savaşın en kısa süresi
const BATTLE_TUT_MIN_MS=8000;
const BATTLE_PER_HOUR=30;           // saatte en fazla ödüllü savaş
const STAT_CAP={hit:40,weak:30,ko:20};
const TZ_OFF=3*3600e3;              // günlük görevler Türkiye saatine göre yenilenir

function uerr(msg){const e=new Error(msg);e.user=true;return e}
const own=(st,id)=>(st.owned&&st.owned[id])||0;
const tutOn=st=>st.tut>0&&st.tut<8;
function roll(odds,rng){let x=rng()*100;for(let i=0;i<4;i++){if((x-=odds[i])<0)return i}return 0}
function drawCard(r,set,rng){const P=POOLS[set===2?2:1][r],tot=P.reduce((t,c)=>t+cw(c),0);let x=rng()*tot;for(const c of P){if((x-=cw(c))<0)return c}return P[P.length-1]}
function rollPack(pity,set,rng){
  // Nadir ve Destansı kartların hepsi evrim kartı: çoğu zaman yerine Yaygın (temel) kart gelir
  const out=PACK.slots.map(o=>{const c=drawCard(roll(o,rng),set,rng);return c.stage>0&&rng()>STAGE_W[c.stage]?drawCard(0,set,rng):c});
  let hasL=out.some(c=>c.r===3);
  if(!hasL&&pity+1>=PACK.pity){out[out.length-1]=drawCard(3,set,rng);hasL=true}
  return{out,pity:hasL?0:pity+1};
}
const copies=(st,c)=>Math.max(0,own(st,rootOf(c).id)-1);   // koleksiyondaki 1 tane hariç fazla kopyalar
function canEvo(st,t){return !!t&&t.stage>0&&!t.ex&&copies(st,t)>=EVO_NEED[t.stage]&&(t.stage<2||own(st,t.from)>0)}
function canAwaken(st,c){const X=c&&exOf(c),ch=c?ADV_CH.findIndex(x=>x[0]===c.el):-1;
  return !!(X&&!own(st,X.id)&&own(st,c.id)>=1+EXCOST.copies&&(st.dust||0)>=EXCOST.dust&&(st.exB||{})[ch])}
function giveSup(st,k,n=1){st.sup=st.sup||{};st.sup[k]=(st.sup[k]||0)+n}
const rndSup=rng=>rng()<.2?'evo':ELS[Math.floor(rng()*ELS.length)];
function addXp(st,n){let ups=0;st.xp+=n;while(st.xp>=XP.need(st.lvl)){st.xp-=XP.need(st.lvl);st.lvl++;ups++;st.free+=XP.reward.free;st.gold+=XP.reward.gold}return ups}
function noteRare(st,c,now){if(c.r<2)return;st.rare=[{id:c.id,t:now},...(st.rare||[])].slice(0,3)}
function shinyRoll(st,c,rng){const sh=rng()<SHINY.chance,newSh=sh&&!((st.shiny||{})[c.id]>0);if(sh){st.shiny=st.shiny||{};st.shiny[c.id]=(st.shiny[c.id]||0)+1}return{sh,newSh}}
function giftTick(st,now){if(st.gift==null){st.gift=1;st.gt=now}
  if(st.gift>=GIFT.max){st.gt=now;return}
  const n=Math.floor((now-(st.gt||now))/GIFT.every);if(n>0){const add=Math.min(n,GIFT.max-st.gift);st.gift+=add;st.gt+=add*GIFT.every;if(st.gift>=GIFT.max)st.gt=now}}
const dayKey=now=>{const d=new Date(now+TZ_OFF);return d.getUTCFullYear()+'-'+(d.getUTCMonth()+1)+'-'+d.getUTCDate()};
// günlük görevler: gün ve oyuncu numarasından belirlenir (sunucu ve oyun aynı listeyi üretir)
function dqList(st,now){const k=dayKey(now);if(!st.dq||st.dq.day!==k){
    const r=srnd([...k].reduce((a,c)=>a*31+c.charCodeAt(0),7)+(st.uidN||0));
    const idx=[...DQP.keys()].sort(()=>r()-.5).slice(0,3);
    const els=[...new Set(CARDS.filter(c=>own(st,c.id)>0).map(c=>c.el))].sort();
    st.dq={day:k,bonus:0,l:idx.map(i=>({i,p:0,c:0,el:DQP[i].el?els[Math.floor(r()*els.length)]||'fire':null}))}}
  return st.dq}
function dqInc(st,t,el,inc,now){const q=dqList(st,now);q.l.forEach(m=>{const D=DQP[m.i];if(D.t!==t||m.p>=D.n)return;if(D.el&&m.el!==el)return;m.p=Math.min(D.n,m.p+inc)})}
function tutRig(st,out){if(!(st.tut>=2&&st.tut<5&&(st.tp||0)<TUT.packs))return out;for(let k=0;k<TUT.perPack;k++)out[k]=BY[TUT.card];st.tp=(st.tp||0)+1;if(st.tp>=TUT.packs)st.tut=5;return out}

// Eksik alanları tamamlar, zamanla gelen şeyleri (hediye, günlük görev) günceller. Her işlemden önce çalışır.
function normalize(st,ctx){const F=fresh();for(const k in F)if(st[k]==null)st[k]=F[k];
  if(typeof st.owned!=='object'||!st.owned)st.owned={};
  // macera diyar başına 5'ten 10 bölüme çıktı: eski ilerleme yeni numaralandırmaya taşınır
  if(st.advV!==2){const c=st.advC||0;st.advC=Math.min(ADV_N,Math.floor(c/5)*ADV_P+(c%5)*2);st.advV=2}
  if(st.uidN==null)st.uidN=ctx.uid!=null?((ctx.uid*7919+13)%1e6):Math.floor(ctx.rng()*1e6);
  if(st.supV===1&&!st.supV2){giveSup(st,'metal',1);giveSup(st,'poison',1);st.supV2=1}
  if(st.supV!==1){st.sup=st.sup||{};giveSup(st,'evo',2);ELS.forEach(e=>giveSup(st,e,1));st.supV=1}
  if(st.tut==null){if(!Object.keys(st.owned).length&&!st.opened){st.tut=1;st.tp=0;st.th=0;st.owned={[TUT.card]:TUT.start}}else st.tut=9}
  giftTick(st,ctx.now);dqList(st,ctx.now);return st}

// İstemci kaydını sunucudakine güvenli şekilde katar: sadece CLIENT_KEYS ve öğreticinin ilk adımları.
function mergeClient(st,data){for(const k of CLIENT_KEYS)if(data[k]!==undefined)st[k]=data[k];
  if(Number.isInteger(data.tut)&&data.tut>st.tut&&data.tut<=TUT_CLIENT_MAX)st.tut=data.tut;
  if(Array.isArray(st.deck2))st.deck2=st.deck2.slice(0,30);if(Array.isArray(st.deck))st.deck=st.deck.slice(0,30);return st}

function battleEnd(st,p,ctx){const bt=st.bt,now=ctx.now;
  if(!bt||bt.id!==p.id)throw uerr('Bu savaş sunucuda bulunamadı. Yeni bir savaş başlat.');
  st.bt=null;const win=!!p.win,el=now-bt.t0;
  if(el<(bt.tut?BATTLE_TUT_MIN_MS:BATTLE_MIN_MS))throw uerr('Savaş çok kısa sürdü, sonuç kaydedilmedi.');
  // vuruş / zayıf vuruş / KO sayıları oyundan gelir: makul sınırla kırpılır
  const S0=p.stats||{},hit=S0.hit&&typeof S0.hit==='object'?S0.hit:{};let ht=0;
  for(const e of Object.keys(hit)){if(!ELS.includes(e)&&e!=='blood')continue;const n=Math.max(0,Math.min(STAT_CAP.hit-ht,Math.floor(+hit[e]||0)));ht+=n;if(n)dqInc(st,'hit',e,n,now)}
  const wk=Math.max(0,Math.min(STAT_CAP.weak,Math.floor(+S0.weak||0))),ko=Math.max(0,Math.min(STAT_CAP.ko,Math.floor(+S0.ko||0)));
  if(wk)dqInc(st,'weak',null,wk,now);if(ko)dqInc(st,'ko',null,ko,now);
  dqInc(st,'battle',null,1,now);if(win)dqInc(st,'win',null,1,now);
  if(bt.mode==='friend')return{mode:'friend',win,opp:bt.fr||null};
  st.bl=(st.bl||[]).filter(t=>now-t<3600e3);
  if(st.bl.length>=BATTLE_PER_HOUR)throw uerr('Bu saat için savaş ödülü sınırına ulaştın. Biraz sonra tekrar dene.');
  st.bl.push(now);
  if(bt.mode==='adv'){const st0=advStage(bt.adv),first=st0.x?!(st.exB||{})[st0.ch]:bt.adv>=(st.advC||0),R={mode:'adv',win,adv:bt.adv,first:win&&first,pk:0,du:0,sup:null};
    R.g=win?(first?st0.gold:Math.round(st0.gold/4)):10;st.gold+=R.g;
    if(R.first){st.dust+=st0.dust;R.du=st0.dust;if(st0.x){st.exB=st.exB||{};st.exB[st0.ch]=1}else st.advC=bt.adv+1;if(st0.pack){st.free+=st0.pack;R.pk=st0.pack}R.sup=st0.x||st0.p===ADV_P-1?'evo':st0.el;giveSup(st,R.sup)}
    if(win)dqInc(st,'adv',null,1,now);return R}
  const R={mode:'arena',win},lg0=lgOf(st.trophy||0),floor=LEAGUES[lg0].min;R.lg0=lg0;R.g=win?ECON.win+LEAGUES[lg0].gold:ECON.loss;st.gold+=R.g;
  R.dt=win?TROPHY.win:Math.max(TROPHY.loss,floor-(st.trophy||0));R.sb=null;R.chest=0;R.lost=0;
  if(win){st.streak=(st.streak||0)+1;if(st.streak>(st.bestStk||0))st.bestStk=st.streak;const sb=strkB(st.streak);if(sb.tr||sb.g){R.sb={n:st.streak,...sb};R.dt+=sb.tr;R.g+=sb.g;st.gold+=sb.g}
    st.chest=(st.chest||0)+1;if(st.chest>=CHEST.need){st.chest-=CHEST.need;st.chests=(st.chests||0)+1;R.chest=1}}
  else{R.lost=st.streak||0;st.streak=0}
  st.lstreak=win?0:(st.lstreak||0)+1;   // üst üste arena yenilgisi: 3 ve üstünde sıradaki rakip kolaylaşır
  st.trophy=Math.max(0,(st.trophy||0)+R.dt);if(win)st.wins++;else st.losses++;
  st.hist=[...(st.hist||[]),{w:win?1:0,dt:R.dt}].slice(-5);
  R.tutEnd=0;if(st.tut===6){st.tut=8;st.free++;R.tutEnd=1}
  R.lg1=lgOf(st.trophy);R.reward=0;if(R.lg1>(st.bestLg||0)){for(let k=(st.bestLg||0)+1;k<=R.lg1;k++)R.reward+=LEAGUES[k].reward;st.free+=R.reward;st.bestLg=R.lg1}
  R.trophy=st.trophy;R.streak=st.streak||0;R.chestP=st.chest||0;return R}

// Bitmeden terk edilen arena savaşı yenilgi sayılır (kaybedeceğini görünce sayfayı yenileyip kaçmayı önler).
function forfeit(st,now){const bt=st.bt;st.bt=null;if(!bt||bt.mode!=='arena'||bt.tut)return null;
  const lg0=lgOf(st.trophy||0),floor=LEAGUES[lg0].min,dt=Math.max(TROPHY.loss,floor-(st.trophy||0));
  st.trophy=Math.max(0,(st.trophy||0)+dt);st.losses++;st.streak=0;st.lstreak=(st.lstreak||0)+1;st.hist=[...(st.hist||[]),{w:0,dt}].slice(-5);return{dt}}

// Tek giriş noktası: a = işlem adı, p = parametreler, ctx = {rng, now, uid?, friendOk?}
function act(st,a,p,ctx){p=p||{};const rng=ctx.rng,now=ctx.now;normalize(st,ctx);
  switch(a){
  case 'pack':{const set=tutOn(st)?1:(p.set===2?2:1);
    if(st.free>0)st.free--;else if(st.gold>=PACK.cost)st.gold-=PACK.cost;else throw uerr('Yeterli altının yok.');
    const pityBefore=st.pity,r=rollPack(st.pity,set,rng);st.pity=r.pity;const out=tutRig(st,r.out);
    let xpGain=0;dqInc(st,'pack',null,1,now);
    const res=out.map(c=>{const isNew=!own(st,c.id);st.owned[c.id]=own(st,c.id)+1;xpGain+=XP.card[c.r]*(isNew?XP.newMult:1);noteRare(st,c,now);
      const s=shinyRoll(st,c,rng);return{id:c.id,isNew,sh:s.sh,newSh:s.newSh}});
    res.sort((x,y)=>BY[x.id].r-BY[y.id].r||(x.isNew-y.isNew));   // en nadir en sona
    const from={lvl:st.lvl,xp:st.xp},ups=addXp(st,xpGain);st.opened++;
    return{res,xp:{from,gain:xpGain,ups},pityHit:pityBefore+1>=PACK.pity}}
  case 'chest':{if(!(st.chests>0))throw uerr('Açılacak sandığın yok.');st.chests--;const lg=lgOf(st.trophy||0),g=CHEST.gold(lg),d=CHEST.dust(lg);
    let c=drawCard(roll(CHEST.card,rng),1,rng);if(c.stage>0&&rng()>STAGE_W[c.stage])c=drawCard(0,1,rng);
    const isNew=!own(st,c.id);st.owned[c.id]=own(st,c.id)+1;noteRare(st,c,now);const s=shinyRoll(st,c,rng),pk=rng()<CHEST.pack;
    st.gold+=g;st.dust+=d;if(pk)st.free++;const sup=rng()<.4?rndSup(rng):null;if(sup)giveSup(st,sup);addXp(st,XP.card[c.r]*(isNew?XP.newMult:1));
    return{g,d,id:c.id,isNew,sh:s.sh,pk,sup}}
  case 'gift':{const n=st.gift||0;if(n<1)throw uerr('Henüz hediye paketi yok.');st.free+=n;st.gift=0;st.gt=now;return{n}}
  case 'evo':{const t=BY[p.id];if(!canEvo(st,t))throw uerr('Bu evrim için yeterli kopyan yok.');const root=rootOf(t);
    st.owned[root.id]-=EVO_NEED[t.stage];st.owned[t.id]=own(st,t.id)+1;st.evoN=(st.evoN||0)+1;if(st.tut===5&&t.id===TUT.evo)st.tut=6;return{id:t.id,from:root.id}}
  case 'awaken':{const c=BY[p.id];if(!canAwaken(st,c))throw uerr('Uyanış şartları tamamlanmadı.');const X=exOf(c);
    st.owned[c.id]-=EXCOST.copies;st.dust-=EXCOST.dust;st.owned[X.id]=1;st.awkN=(st.awkN||0)+1;return{id:X.id}}
  case 'craft':{const c=BY[p.id];if(!c||c.ex||c.stage!==0||own(st,c.id))throw uerr('Bu kart üretilemez.');const R=RAR[c.r];
    if((st.dust||0)<R.craft)throw uerr('Yeterli tozun yok.');st.dust-=R.craft;st.owned[c.id]=1;return{id:c.id}}
  case 'todust':{const c=BY[p.id];if(!c||c.ex)throw uerr('Bu kart toza çevrilemez.');const extra=own(st,c.id)-1;if(extra<1)throw uerr('Fazla kopyan yok.');
    const g=extra*RAR[c.r].dust;st.dust+=g;st.owned[c.id]=1;return{dust:g}}
  case 'dq':{const q=dqList(st,now),j=p.j;
    if(j==='b'){if(q.bonus||!q.l.every(m=>m.c))throw uerr('Önce üç görevi de tamamla.');q.bonus=1;st.free+=DQB.free;const sk=rndSup(rng);giveSup(st,sk);return{bonus:1,free:DQB.free,sup:sk}}
    const m=q.l[+j];if(!m)throw uerr('Görev bulunamadı.');const D=DQP[m.i];if(m.c)throw uerr('Bu görevin ödülünü zaten aldın.');if(m.p<D.n)throw uerr('Görev henüz tamamlanmadı.');
    m.c=1;st.gold+=D.g;st.dust+=D.d;return{g:D.g,d:D.d}}
  case 'battle_start':{const mode=p.mode==='adv'?'adv':p.mode==='friend'?'friend':'arena';let adv=null;
    if(mode==='adv'){adv=Math.floor(+p.adv);const c=st.advC||0;
      const ok=adv>=0&&(adv<ADV_N?adv<=c:(adv>=100&&adv<100+ADV_CH.length&&c>=(adv-99)*ADV_P));if(!ok)throw uerr('Bu bölüm henüz açılmadı.')}
    if(mode==='friend'&&!ctx.friendOk)throw uerr('Sadece arkadaşlarının ya da klan üyelerinin destesiyle savaşabilirsin.');
    const fo=forfeit(st,now);
    const id=Math.floor(rng()*2**52).toString(36);st.bt={id,mode,adv,t0:now,tut:mode==='arena'&&st.tut===6?1:0};if(mode==='friend'&&typeof p.fr==='string')st.bt.fr=p.fr.slice(0,16);
    return{id,forfeit:fo}}
  case 'battle_end':return battleEnd(st,p,ctx);
  case 'ach_claim':{const id=String(p.id||''),rw=ACH_RW[id];
    if(!rw||!(st.ach||[]).includes(id))throw uerr('Bu başarım henüz tamamlanmadı.');
    if((st.achC||[]).includes(id))throw uerr('Bu ödülü zaten aldın.');
    st.achC=[...(st.achC||[]),id];st.gold=(st.gold||0)+(rw.g||0);st.free=(st.free||0)+(rw.f||0);return{g:rw.g||0,f:rw.f||0}}
  case 'avatar':{const id=Math.floor(+p.id),c=BY[id];if(!c||!(own(st,id)>0))throw uerr('Sadece sahip olduğun bir kartı profil resmi yapabilirsin.');st.av=id;return{av:id}}
  }
  throw uerr('Bilinmeyen işlem.');
}
/* ---------- HAFTALIK SEZON (arkadaşlar + klan arası) ----------
   Sezon her pazartesi 00:00 Türkiye saatinde (UTC+3) başlar. Puan = sezonda arenada kazanılan net kupa. */
const SEASON={week:604800e3,offset:4*86400e3-3*3600e3,   // 1970-01-05 pazartesi 00:00 UTC+3
  rewards:[{pk:5,g:600},{pk:3,g:400},{pk:2,g:200}],part:{pk:0,g:100},minPlayers:3,
  // genel (tüm oyuncular) sıralamasının küçük ödülü: önceki sezonda en az gMin oyuncu oynadıysa ilk 3
  gRewards:[{pk:1,g:150},{g:100},{g:50}],gMin:5};
const seasonOf=now=>Math.floor((now-SEASON.offset)/SEASON.week);
const seasonEnd=id=>(id+1)*SEASON.week+SEASON.offset;
// rows: [{me, pts, wins, losses}] → ödül (sıra + paket/altın) ya da null
function seasonRewardFor(rows){const P=rows.filter(r=>(r.wins||0)+(r.losses||0)>0).sort((a,b)=>(b.pts-a.pts)||((b.wins||0)-(a.wins||0)));
  const i=P.findIndex(r=>r.me);if(i<0)return null;const rank=i+1;
  const top=P.length>=SEASON.minPlayers&&rank<=3?SEASON.rewards[rank-1]:null;return{rank,n:P.length,...(top||SEASON.part),top:!!top}}
function seasonGive(st,rw){st.free+=rw.pk||0;st.gold+=rw.g||0;if(rw.rank&&(!st.ssBest||rw.rank<st.ssBest))st.ssBest=rw.rank;return rw}
/* ---------- KLAN VE KART İSTEME ---------- */
const CLAN={cost:500,max:30,nameMin:3,nameMax:20,descMax:80};
// kart isteği: 8 saatte bir, 24 saat açık; Yaygın 10, Nadir 4 kopya; bağışçının en az 2 kopyası olmalı
const REQ={every:8*3600e3,dur:24*3600e3,need:[10,4],donorMin:2,reward:[{g:5,xp:1},{g:15,xp:3}],daily:20};
const reqable=c=>!!c&&c.r<=1&&!c.ex&&!c.ez;
function reqCheck(st,id,now){const c=BY[id];if(!reqable(c))throw uerr('Sadece Yaygın ve Nadir kartlar istenebilir.');
  if(!(own(st,id)>0))throw uerr('Sadece sahip olduğun bir kartı isteyebilirsin.');
  const wait=(st.rqT||0)+REQ.every-now;if(wait>0)throw uerr(`Yeni istek için ${Math.ceil(wait/6e4)} dakika beklemelisin.`);return c}
function reqOpen(st,id,now){const c=reqCheck(st,id,now);st.rqT=now;return{need:REQ.need[c.r]}}
const dnLeft=(st,now)=>{const d=dayKey(now);return st.dn&&st.dn.day===d?Math.max(0,REQ.daily-st.dn.n):REQ.daily};
function donateCheck(st,id,now){const c=BY[id];if(!reqable(c))throw uerr('Bu kart bağışlanamaz.');
  if(own(st,id)<REQ.donorMin)throw uerr(`Bağış için bu karttan en az ${REQ.donorMin} kopyan olmalı.`);
  if(dnLeft(st,now)<=0)throw uerr(`Bugünkü bağış sınırına ulaştın (${REQ.daily} kart).`);return c}
function donateGive(st,id,now){const c=donateCheck(st,id,now),R=REQ.reward[c.r],d=dayKey(now);
  st.owned[id]-=1;st.gold+=R.g;st.dnTot=(st.dnTot||0)+1;const ups=addXp(st,R.xp);st.dn=st.dn&&st.dn.day===d?{day:d,n:st.dn.n+1}:{day:d,n:1};return{g:R.g,xp:R.xp,ups}}
function donateGet(st,id){st.owned[id]=own(st,id)+1}
function clanPay(st){if((st.gold||0)<CLAN.cost)throw uerr(`Klan kurmak için ${CLAN.cost} altın gerekli.`);st.gold-=CLAN.cost}

// arkadaşların göreceği özet (sunucu hesaplar)
function pubStats(st){return{tr:st.trophy||0,lg:lgOf(st.trophy||0),lvl:st.lvl||1,col:CARDS.filter(c=>own(st,c.id)>0).length,tot:N,w:st.wins||0,l:st.losses||0,av:avatarOf(st)}}

/* ---------- PROFİL: RESİM VE BAŞARIMLAR ---------- */
// Profil resmi: seçilen kart (hâlâ sahipse), yoksa en nadir/en yüksek aşamalı kartı, hiç yoksa öğretici kartı.
function avatarOf(st){if(st.av&&own(st,st.av)>0&&BY[st.av])return st.av;
  let b=null;for(const c of CARDS)if(own(st,c.id)>0&&(!b||c.r>b.r||(c.r===b.r&&(c.stage||0)>(b.stage||0))))b=c;return b?b.id:TUT.card}
// Başarımlar: sadece rozet ve ilerleme (ödül yok). x = {inClan} sunucudan gelir.
const ACH=[
  {id:'w1',n:'İlk Zafer',d:'Arenada ilk galibiyetini al',g:1,v:s=>s.wins||0},
  {id:'w10',n:'Çaylak Savaşçı',d:'Arenada 10 galibiyet',g:10,v:s=>s.wins||0},
  {id:'w50',n:'Arena Gazisi',d:'Arenada 50 galibiyet',g:50,v:s=>s.wins||0},
  {id:'w200',n:'Arena Efsanesi',d:'Arenada 200 galibiyet',g:200,v:s=>s.wins||0},
  {id:'s5',n:'Seri Avcısı',d:'Üst üste 5 galibiyet',g:5,v:s=>s.bestStk||0},
  {id:'s10',n:'Durdurulamaz',d:'Üst üste 10 galibiyet',g:10,v:s=>s.bestStk||0},
  ...[1,2,3,4,5].map(k=>({id:'lg'+k,n:LEAGUES[k].n+' Lig',d:LEAGUES[k].n+' lige yüksel',g:1,v:s=>(s.bestLg||0)>=k?1:0,lg:k})),
  {id:'p10',n:'Paket Meraklısı',d:'10 paket aç',g:10,v:s=>s.opened||0},
  {id:'p50',n:'Paket Avcısı',d:'50 paket aç',g:50,v:s=>s.opened||0},
  {id:'p200',n:'Paket Ustası',d:'200 paket aç',g:200,v:s=>s.opened||0},
  {id:'c25',n:'Koleksiyoncu',d:'Koleksiyonun %25\'ini topla',g:Math.ceil(N*.25),v:s=>CARDS.filter(c=>own(s,c.id)>0).length},
  {id:'c50',n:'Büyük Koleksiyoncu',d:'Koleksiyonun %50\'sini topla',g:Math.ceil(N*.5),v:s=>CARDS.filter(c=>own(s,c.id)>0).length},
  {id:'c100',n:'Tam Koleksiyon',d:'Bütün kartları topla',g:N,v:s=>CARDS.filter(c=>own(s,c.id)>0).length},
  {id:'evo',n:'İlk Evrim',d:'Bir kartı evrimleştir',g:1,v:s=>s.evoN||0},
  {id:'awk',n:'Uyanış',d:'Bir kartı uyandır',g:1,v:s=>Math.max(s.awkN||0,EXC.some(c=>own(s,c.id)>0)?1:0)},
  {id:'adv',n:'Diyarların Fatihi',d:'Maceradaki bütün bölümleri bitir',g:ADV_N,v:s=>Math.min(ADV_N,s.advC||0)},
  {id:'clan',n:'Klan Kardeşliği',d:'Bir klana katıl',g:1,v:(s,x)=>x&&x.inClan?1:0},
  {id:'d10',n:'Yardımsever',d:'10 kart bağışla',g:10,v:s=>s.dnTot||0},
  {id:'d100',n:'Cömert Kalp',d:'100 kart bağışla',g:100,v:s=>s.dnTot||0},
  {id:'ss3',n:'Sezon Şampiyonu',d:'Haftalık sezonu ilk 3\'te bitir',g:1,v:s=>s.ssBest&&s.ssBest<=3?1:0}];
// başarım ödülleri: g = altın, f = ücretsiz paket (ödül 'Ödülü al' ile bir kez alınır)
const ACH_RW={w1:{g:100},w10:{g:300},w50:{f:2},w200:{f:5,g:1000},s5:{g:300},s10:{f:2},
  lg1:{g:200},lg2:{f:1},lg3:{f:2},lg4:{f:3},lg5:{f:5},p10:{g:100},p50:{f:1},p200:{f:3},
  c25:{f:1},c50:{f:3},c100:{f:5,g:1000},evo:{g:200},awk:{f:1},adv:{f:5,g:1000},clan:{g:200},d10:{g:200},d100:{f:2},ss3:{f:2}};
function achList(st,x){const done=new Set(st.ach||[]),cl=new Set(st.achC||[]);return ACH.map(a=>{const v=Math.min(a.g,a.v(st,x)||0);
  return{id:a.id,n:a.n,d:a.d,g:a.g,v,done:done.has(a.id)||v>=a.g,lg:a.lg,rw:ACH_RW[a.id]||{},cl:cl.has(a.id)}})}
// alınmamış ödülü olan tamamlanmış başarım sayısı (rozet için)
const achUnclaimed=st=>{const cl=new Set(st.achC||[]);return(st.ach||[]).filter(id=>ACH_RW[id]&&!cl.has(id)).length};
// Yeni tamamlananları st.ach'a ekler (bir kez kazanılan rozet geri gitmez), yeni olanların adlarını döner.
// x verilmezse (klan bilinmiyorsa) klan başarımı bu turda değerlendirilmez.
function achSync(st,x){const have=new Set(st.ach||[]),nw=[];
  for(const a of ACH){if(have.has(a.id))continue;if(a.id==='clan'&&!x)continue;if((a.v(st,x)||0)>=a.g){have.add(a.id);nw.push(a.n)}}
  if(nw.length)st.ach=[...have];return nw}

const MR={ELS,round5,round10,RAR,TYPE_HP,TYPE_RET,DMG,ATK,FXV,FX,atkDmg,PACK,XP,ECON,RAW,E1,E2,CARDS,BY,rootOf,N,pad,setOf,setCards,cno,setN,
  EXA,EXCOST,EXD,EXC,exOf,EZA,EZDR,EZC,POOL,POOLS,EVO_NEED,STAGE_W,cw,SHINY,LEAGUES,lgOf,TROPHY,STREAK,strkB,CHEST,GIFT,DQP,DQB,srnd,SUPK,
  ADV_CH,ADV_RULE,ADV_N,ADV_P,advStage,advStageX,TUT,fresh,
  ECON_KEYS,CLIENT_KEYS,BATTLE_MIN_MS,BATTLE_PER_HOUR,own,tutOn,roll,drawCard,rollPack,copies,canEvo,canAwaken,giveSup,rndSup,addXp,
  giftTick,dayKey,dqList,dqInc,normalize,mergeClient,act,pubStats,avatarOf,ACH,ACH_RW,achList,achSync,achUnclaimed,
  SEASON,seasonOf,seasonEnd,seasonRewardFor,seasonGive,
  CLAN,REQ,reqable,reqCheck,reqOpen,dnLeft,donateCheck,donateGive,donateGet,clanPay};
G.MR=MR;
})(typeof globalThis!=='undefined'?globalThis:this);
