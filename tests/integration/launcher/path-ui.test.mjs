import test from 'node:test';
import assert from 'node:assert/strict';
import { pathPurpose } from '../../../tools/launcher/public/path-ui.mjs';

const field = (name, title, purpose) => ({ name, dataset: purpose ? { pathPurpose: purpose } : {}, closest: () => ({ textContent: title }) });

test('PATH-UI-01 path controls distinguish existing sources, files, interpreters and new destinations in both languages', () => {
  for (const [name, title, purpose] of [
    ['directory', '本机整合包目录', 'pack'], ['directory', 'Local pack directory', 'pack'],
    ['moduleDirectory', '候选模块目录', 'module'], ['moduleDirectory', 'Candidate module directory', 'module'],
    ['directory', '模板目录', 'template'], ['directory', 'Template directory', 'template'],
    ['directory', '新的模板目录', 'save-directory'], ['directory', 'New template directory', 'save-directory'],
    ['directory', '要发布的包或模块目录', 'directory'], ['directory', 'Pack or module directory to publish', 'directory'],
    ['proposalDirectory', '收到的提案目录', 'proposal'], ['candidate', 'Candidate locked pack directory', 'pack'],
    ['source', '本机索引文件或 HTTPS 索引地址', 'source'], ['backup', 'Private backup file', 'backup'],
    ['destination', '新的私有备份文件', 'save-file'], ['destination', 'New comment export file', 'save-file'],
    ['destination', '新的派生包目录', 'save-directory'], ['destination', 'New derived pack directory', 'save-directory'],
    ['backupDestination', 'New private backup file path', 'save-file'], ['evidencePath', 'Public signature evidence file', 'file'],
    ['nodePath', 'Node.js', 'executable'], ['pythonPath', 'Python', 'executable'], ['dockerPath', 'Docker', 'executable']
  ]) assert.equal(pathPurpose(field(name, title)), purpose, `${name}: ${title}`);
  assert.equal(pathPurpose(field('author', 'Author')), null); assert.equal(pathPurpose(field('text', 'Comment text')), null);
});

test('PATH-UI-02 explicitly declared purposes keep read and write comment fields separate and remain stable after feedback text changes', () => {
  assert.equal(pathPurpose(field('source', '收到的评论交换文件', 'comments')), 'comments');
  assert.equal(pathPurpose(field('destination', '新的评论导出文件', 'save-file')), 'save-file');
  assert.equal(pathPurpose(field('directory', 'Feedback contains the word file', 'pack')), 'pack');
  assert.equal(pathPurpose(field('destination', 'Pack changed language or explanatory text', 'save-file')), 'save-file');
});
