const express = require('express');
const app = express();
const port = 3000;

app.use(express.json({ extend: false }));
app.use(express.static('./views'));
app.set('view engine', 'ejs');
app.set('views', './views');

app.get('/', (request, response) => {
  response.render('index');
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}!`);
});