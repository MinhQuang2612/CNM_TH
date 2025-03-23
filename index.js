// Import các thư viện cần thiết
const express = require('express');
const app = express();

// Import dotenv để đọc file .env
require('dotenv').config();

// Lấy các biến từ file .env
const port = process.env.PORT || 3000;
const region = process.env.REGION || 'us-east-1';
const accessKeyId = process.env.ACCESS_KEY_ID;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;
const tableName = process.env.TABLE_NAME || 'SanPham';

// Middleware để parse JSON và form
app.use(express.json({ extend: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('./views'));
app.set('view engine', 'ejs');
app.set('views', './views');

// Config AWS DynamoDB với SDK v3
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

// Khởi tạo DynamoDB client
const client = new DynamoDBClient({
  region: region,
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  },
});

// Khởi tạo DocumentClient
const docClient = DynamoDBDocumentClient.from(client);

// Route để hiển thị danh sách sản phẩm
app.get('/', async (req, res) => {
  const params = {
    TableName: tableName,
  };

  try {
    const command = new ScanCommand(params);
    const data = await docClient.send(command);
    return res.render('index', { sanPhams: data.Items });
  } catch (err) {
    console.error('Error scanning DynamoDB:', err);
    res.send('Internal Server Error');
  }
});

// Route để thêm sản phẩm
app.post('/', async (req, res) => {
  const { ma_sp, ten_sp, so_luong } = req.body;

  // Kiểm tra xem ma_sp có tồn tại không
  if (!ma_sp) {
    return res.status(400).send('Missing ma_sp');
  }

  const params = {
    TableName: tableName,
    Item: {
      ma_sp: String(ma_sp), // Chuyển ma_sp thành String
      ten_sp: ten_sp || 'Không có tên', // Giá trị mặc định nếu ten_sp không có
      so_luong: Number(so_luong) || 0, // Giá trị mặc định nếu so_luong không có
    },
  };

  try {
    const command = new PutCommand(params);
    await docClient.send(command);
    return res.redirect('/');
  } catch (err) {
    console.error('Error putting item to DynamoDB:', err);
    return res.send('Internal Server Error');
  }
});

// Route để xóa sản phẩm
app.post('/delete', async (req, res) => {
  const ma_sp_list = req.body.ma_sp;

  if (!ma_sp_list) {
    return res.redirect('/');
  }

  const itemsToDelete = Array.isArray(ma_sp_list) ? ma_sp_list : [ma_sp_list];

  try {
    const deletePromises = itemsToDelete.map(ma_sp => {
      const params = {
        TableName: tableName,
        Key: {
          ma_sp: String(ma_sp), // Chuyển ma_sp thành String
        },
      };
      const command = new DeleteCommand(params);
      return docClient.send(command);
    });

    await Promise.all(deletePromises);
    return res.redirect('/');
  } catch (err) {
    console.error('Error deleting items:', err);
    res.send('Internal Server Error');
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});