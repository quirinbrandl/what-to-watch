import 'dart:convert';
import 'dart:io';

/// A JSON document on disk, written atomically (temp file + rename) so a
/// crash mid-write can never corrupt user data.
class JsonFile {
  final File file;
  JsonFile(String path) : file = File(path);

  Future<Map<String, dynamic>?> read() async {
    try {
      if (!await file.exists()) return null;
      final v = jsonDecode(await file.readAsString());
      return v is Map ? v.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> write(Map<String, dynamic> data) async {
    await file.parent.create(recursive: true);
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(file.path);
  }

  Future<void> delete() async {
    if (await file.exists()) await file.delete();
  }
}
