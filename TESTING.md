# Staff testing (UAT)

The human-facing testing guide is the styled, interactive web page — share this link:

**https://fs.4dcs.co.za/testing.html**

(install steps, role table, phased plan, per-role checklists with progress saved on each
tester's phone, printable). It is also linked from the app's burger menu ("Testing guide").
Edit `testing.html` to change the content.

After sign-off, wipe practice data before go-live:

```sql
delete from fs_photos; delete from fs_readings; delete from fs_visits;
delete from fs_farmers where source = 'fs_registered';
```
