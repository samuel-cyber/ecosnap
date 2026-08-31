// test-connection.js
// Run once with: node test-connection.js
// Confirms insert, read, and delete all work against your real Supabase project.
// Safe to delete after it passes.

require('dotenv').config();
const supabase = require('./src/config/supabaseClient');

(async () => {
  const { data: inserted, error: insertError } = await supabase
    .from('users')
    .insert({ display_name: 'Connection Test User', neighborhood: 'Yaba' })
    .select();

  if (insertError) {
    console.error('INSERT FAILED:', insertError.message);
    process.exit(1);
  }
  console.log('INSERT OK:', inserted);

  const { data: read, error: readError } = await supabase
    .from('users')
    .select('*')
    .eq('id', inserted[0].id);

  if (readError) {
    console.error('READ FAILED:', readError.message);
    process.exit(1);
  }
  console.log('READ OK:', read);

  const { error: deleteError } = await supabase
    .from('users')
    .delete()
    .eq('id', inserted[0].id);

  if (deleteError) {
    console.error('CLEANUP FAILED:', deleteError.message);
    process.exit(1);
  }
  console.log('CLEANUP OK: test row removed. Your Supabase connection works.');
})();
