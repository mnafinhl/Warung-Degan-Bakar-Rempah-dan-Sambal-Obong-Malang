const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Izinkan semua origin untuk pengembangan
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.db');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads'); // Direktori untuk menyimpan bukti transfer

// Pastikan folder uploads ada
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Konfigurasi Multer untuk upload file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Nama file unik: timestamp-originalfilename
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(cors()); // Mengizinkan CORS untuk permintaan lintas origin
app.use(express.json()); // Mengizinkan Express untuk membaca body JSON
// Melayani file statis dari direktori root (tempat HTML berada, termasuk 'Testing Warung Degan Bakar Rempah.html')
app.use(express.static(path.join(__dirname)));
// Melayani file yang diunggah dari /uploads
app.use('/uploads', express.static(UPLOAD_DIR));

// Inisialisasi database SQLite
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            // Buat tabel orders jika belum ada
            // PASTIKAN TIDAK ADA KOLOM 'notes' DI SINI.
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                table_number TEXT,
                total_price REAL NOT NULL,
                payment_method TEXT,
                status TEXT DEFAULT 'Menunggu Pembayaran',
                order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                bukti_transfer TEXT,
                items_summary TEXT
            )`);
            // Buat tabel order_items jika belum ada
            db.run(`CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER,
                item_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                price REAL NOT NULL,
                notes TEXT, /* Notes ini untuk catatan per item, bukan catatan pesanan keseluruhan. Ini sudah ada di kode Anda sebelumnya. */
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            )`);
        });
    }
});

// --- SISTEM LOGIN DAN AUTENTIKASI (Hanya untuk Aplikasi Kasir) ---

const VALID_USERNAME = 'pakkasir';
const VALID_PASSWORD = 'yangtauhanyapegawaisegerwaras'; // Ingat, untuk produksi, ini harus di-hash

// Middleware autentikasi dasar
// Ini adalah autentikasi yang sangat sederhana untuk tujuan demo.
// Untuk aplikasi produksi, disarankan menggunakan JWT, session, atau OAuth.
function authenticateRequest(req, res, next) {
    // Memeriksa header 'X-Logged-In'. Header ini dikirim oleh JavaScript di kasir.html
    // setelah login berhasil.
    if (req.headers['x-logged-in'] === 'true') {
        next(); // Lanjutkan ke handler route jika terautentikasi
    } else {
        res.status(401).json({ message: 'Akses tidak sah. Harap login.' }); // Kirim error 401 jika tidak terautentikasi
    }
}

// Route POST untuk memproses login
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === VALID_USERNAME && password === VALID_PASSWORD) {
        res.json({ success: true, message: 'Login berhasil!' });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }
});

// Route untuk halaman utama kasir (dilindungi autentikasi)
app.get('/', authenticateRequest, (req, res) => {
    res.sendFile(path.join(__dirname, 'kasir.html'));
});

// Route langsung ke kasir.html (dilindungi autentikasi)
app.get('/kasir.html', authenticateRequest, (req, res) => {
    res.sendFile(path.join(__dirname, 'kasir.html'));
});

// Route untuk halaman testing/pelanggan (tidak dilindungi autentikasi)
// Pastikan nama file HTML sama persis
app.get('/testing', (req, res) => {
    res.sendFile(path.join(__dirname, 'Testing Warung Degan Bakar Rempah.html'));
});

// --- API UNTUK MANAJEMEN PESANAN (BEBERAPA DILINDUNGI AUTENTIKASI, BEBERAPA TIDAK) ---

// Mendapatkan semua pesanan beserta item-itemnya (DILINDUNGI AUTHENTIKASI, HANYA UNTUK KASIR)
app.get('/orders', authenticateRequest, (req, res) => {
    db.all(`SELECT * FROM orders ORDER BY order_date DESC`, [], (err, orders) => {
        if (err) {
            console.error('Error fetching orders:', err.message);
            return res.status(500).json({ message: 'Gagal mengambil daftar pesanan.', error: err.message });
        }
        
        // Jika tidak ada pesanan, kirim array kosong
        if (orders.length === 0) {
            return res.json([]);
        }

        let ordersWithItems = [];
        let completedQueries = 0;

        orders.forEach((order) => {
            db.all(`SELECT item_name, quantity, price, notes FROM order_items WHERE order_id = ?`, [order.id], (err, items) => {
                if (err) {
                    console.error('Error fetching order items for order ID ' + order.id + ':', err.message);
                    order.items = []; // Jika ada error, set items kosong
                } else {
                    order.items = items;
                }
                ordersWithItems.push(order);
                completedQueries++;

                // Ketika semua query item selesai, kirim response
                if (completedQueries === orders.length) {
                    ordersWithItems.sort((a, b) => new Date(b.order_date) - new Date(a.order_date)); // Urutkan lagi berdasarkan tanggal terbaru
                    res.json(ordersWithItems);
                }
            });
        });
    });
});

// Mendapatkan detail satu pesanan (DILINDUNGI AUTHENTIKASI, HANYA UNTUK KASIR)
app.get('/order/:id', authenticateRequest, (req, res) => {
    const orderId = req.params.id;
    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, row) => {
        if (err) {
            console.error('Error fetching single order:', err.message);
            return res.status(500).json({ message: 'Gagal mengambil detail pesanan.', error: err.message });
        }
        if (!row) {
            return res.status(404).json({ message: 'Pesanan tidak ditemukan.' });
        }
        res.json(row);
    });
});

// Mendapatkan item-item untuk pesanan tertentu (DILINDUNGI AUTHENTIKASI, HANYA UNTUK KASIR)
app.get('/order-items/:orderId', authenticateRequest, (req, res) => {
    const orderId = req.params.orderId;
    db.all(`SELECT item_name, quantity, price, notes FROM order_items WHERE order_id = ?`, [orderId], (err, rows) => {
        if (err) {
            console.error('Error fetching order items:', err.message);
            return res.status(500).json({ message: 'Gagal mengambil item pesanan.', error: err.message });
        }
        res.json(rows);
    });
});


// Menambahkan pesanan baru (TIDAK DILINDUNGI AUTENTIKASI, UNTUK PELANGGAN)
app.post('/submit-order', (req, res) => {
    const { customerName, tableNumber, totalPrice, paymentMethod, cart } = req.body;

    // Validasi input
    if (!customerName || !cart || cart.length === 0 || totalPrice <= 0) {
        return res.status(400).json({ message: 'Data pesanan tidak lengkap atau tidak valid.' });
    }

    let initialStatus;

    // Tentukan status awal berdasarkan metode pembayaran
    // UNTUK TUNAI dan QRIS, status awal adalah 'Menunggu Pembayaran'
    if (paymentMethod === 'TUNAI' || paymentMethod === 'QRIS') { 
        initialStatus = 'Menunggu Pembayaran'; 
    } else {
        initialStatus = 'Menunggu Konfirmasi'; // Default untuk metode lain jika ada
    }

    // Buat ringkasan item untuk disimpan di tabel orders
    const itemsSummary = cart.map(item => `${item.name} x${item.quantity}${item.notes ? ` (${item.notes})` : ''}`).join(', ');
    
    // Pastikan query INSERT INTO orders tidak menyertakan kolom 'notes' untuk pesanan keseluruhan
    db.run(
        `INSERT INTO orders (customer_name, table_number, total_price, payment_method, status, items_summary) VALUES (?, ?, ?, ?, ?, ?)`,
        [customerName, tableNumber, totalPrice, paymentMethod, initialStatus, itemsSummary],
        function (err) {
            if (err) {
                console.error('Error inserting order:', err.message);
                return res.status(500).json({ message: 'Gagal membuat pesanan.', error: err.message });
            }

            const orderId = this.lastID; // Dapatkan ID pesanan yang baru dibuat

            // Masukkan setiap item ke tabel order_items
            // Kolom 'notes' di sini adalah untuk catatan PER ITEM, bukan catatan pesanan keseluruhan. Ini memang sudah ada di kode awal Anda.
            const stmt = db.prepare(`INSERT INTO order_items (order_id, item_name, quantity, price, notes) VALUES (?, ?, ?, ?, ?)`);
            cart.forEach(item => {
                stmt.run(orderId, item.name, item.quantity, item.price, item.notes || '');
            });
            stmt.finalize(); // Tutup statement setelah semua item dimasukkan

            // Emit event ke semua client Socket.IO yang terhubung (misal: aplikasi kasir)
            // Pastikan properti 'notes' tidak dikirim dalam emit ini
            io.emit('pesanan-baru', {
                id: orderId,
                customer_name: customerName,
                table_number: tableNumber,
                total_price: totalPrice,
                payment_method: paymentMethod,
                status: initialStatus,
                order_date: new Date().toISOString(), // Kirim tanggal saat ini dalam ISO string (UTC)
                items_summary: itemsSummary
            });

            // Pastikan properti 'orderNotes' tidak ada dalam response ini
            res.status(201).json({ message: 'Pesanan berhasil dibuat!', orderId: orderId, initialStatus: initialStatus });
        }
    );
});

// Mengupdate status pesanan (DILINDUNGI AUTENTIKASI, HANYA UNTUK KASIR)
app.post('/update-status/:id', authenticateRequest, (req, res) => {
    const orderId = req.params.id;
    const { newStatus } = req.body;

    if (!newStatus) {
        return res.status(400).json({ message: 'Status baru tidak boleh kosong.' });
    }

    db.run(`UPDATE orders SET status = ? WHERE id = ?`, [newStatus, orderId], function (err) {
        if (err) {
            console.error('Error updating status:', err.message);
            return res.status(500).json({ message: 'Gagal memperbarui status pesanan.', error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ message: 'Pesanan tidak ditemukan.' });
        }

        io.emit('status-update', { orderId: orderId, newStatus: newStatus }); // Beri tahu client tentang update status
        res.json({ message: 'Status pesanan berhasil diperbarui.' });
    });
});

// Mengupload bukti transfer (TIDAK DILINDUNGI AUTENTIKASI, UNTUK PELANGGAN)
app.post('/upload-qris-proof/:orderId', upload.single('qrisImage'), (req, res) => {
    const orderId = req.params.orderId;
    if (!req.file) {
        return res.status(400).json({ message: 'Tidak ada file yang diunggah.' });
    }

    const filePath = `/uploads/${req.file.filename}`; // Path yang akan disimpan di DB

    // Perbarui status menjadi 'Menunggu Konfirmasi' setelah bukti diunggah (Sesuai keinginan QRIS Anda)
    db.run(`UPDATE orders SET bukti_transfer = ?, status = 'Menunggu Konfirmasi' WHERE id = ?`, [filePath, orderId], function (err) {
        if (err) {
            console.error('Error updating bukti_transfer:', err.message);
            // Hapus file yang sudah terlanjur diupload jika update DB gagal
            fs.unlink(req.file.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting uploaded file:', unlinkErr);
            });
            return res.status(500).json({ message: 'Gagal menyimpan bukti pembayaran.', error: err.message });
        }
        if (this.changes === 0) {
            // Hapus file juga jika order ID tidak ditemukan
            fs.unlink(req.file.path, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting uploaded file:', unlinkErr);
            });
            return res.status(404).json({ message: 'Pesanan tidak ditemukan.' });
        }

        io.emit('bukti-transfer-uploaded', { orderId: orderId, filePath: filePath }); // Beri tahu client tentang upload bukti
        io.emit('status-update', { orderId: orderId, newStatus: 'Menunggu Konfirmasi' }); // Beri tahu client tentang update status
        res.json({ message: 'Bukti pembayaran berhasil diunggah!', filePath: filePath });
    });
});

// --- SOCKET.IO CONNECTIONS ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// --- SERVER START ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Aplikasi Kasir: http://localhost:${PORT}/kasir.html`);
    console.log(`Aplikasi Pelanggan: http://localhost:${PORT}/Testing Warung Degan Bakar Rempah.html`);
});

// Menutup koneksi database saat aplikasi dimatikan
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Closed the database connection.');
        process.exit(0);
    });
});