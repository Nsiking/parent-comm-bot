'use strict';
// Which product these backups belong to, and where its database lives.
const path = require('path');
module.exports = () => ({
  slug: 'parent-bot', label: 'Parent Bot',
  dbPath: path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'parentbot.db'),
});
