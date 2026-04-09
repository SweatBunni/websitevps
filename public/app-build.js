(function () {
  function parseGeneratedFiles(fullText) {
    const files = {};
    const re = /```(?:\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = re.exec(fullText || '')) !== null) {
      const body = match[1];
      const pathMatch = body.match(/^\/\/\s*File:\s*(.+?)\s*\n/i);
      if (pathMatch) {
        const filePath = pathMatch[1].trim();
        const content = body.slice(pathMatch[0].length).trimEnd();
        files[filePath] = content;
        continue;
      }

      const isGradle = /^(plugins|dependencies|repositories)\s*\{/m.test(body);
      const isProps = /^minecraft_version\s*=/m.test(body);
      const isJson = body.trimStart().startsWith('{');
      if (isGradle && /settings/i.test(body)) {
        files['settings.gradle'] = body.trimEnd();
      } else if (isGradle) {
        files['build.gradle'] = body.trimEnd();
      } else if (isProps) {
        files['gradle.properties'] = body.trimEnd();
      } else if (isJson && /modId|mod_id|fabric/i.test(body)) {
        files['src/main/resources/fabric.mod.json'] = body.trimEnd();
      } else {
        const pkgMatch = body.match(/^package\s+([\w.]+)\s*;/m);
        const classMatch = body.match(/(?:public\s+)?(?:class|interface|enum|record)\s+(\w+)/m);
        if (pkgMatch && classMatch) {
          const pkgPath = pkgMatch[1].replace(/\./g, '/');
          files[`src/main/java/${pkgPath}/${classMatch[1]}.java`] = body.trimEnd();
        }
      }
    }

    return files;
  }

  function withWrapperFiles(files, wrapperFiles) {
    const next = { ...(files || {}) };
    if (!next['gradlew']) next['gradlew'] = wrapperFiles.gradlew;
    if (!next['gradlew.bat']) next['gradlew.bat'] = wrapperFiles.gradlewBat;
    if (!next['gradle/wrapper/gradle-wrapper.properties']) {
      next['gradle/wrapper/gradle-wrapper.properties'] = wrapperFiles.wrapperProperties;
    }
    if (!next['gradle/wrapper/gradle-wrapper.jar']) {
      next['gradle/wrapper/gradle-wrapper.jar'] = wrapperFiles.wrapperJar;
    }
    return next;
  }

  function getRequiredProjectFiles(loader) {
    const required = ['build.gradle', 'settings.gradle', 'gradle.properties'];
    if (loader === 'fabric') required.push('src/main/resources/fabric.mod.json');
    if (loader === 'forge' || loader === 'neoforge') required.push('src/main/resources/META-INF/mods.toml');
    return required;
  }

  function getMissingProjectFiles(loader, files) {
    const normalized = new Set(Object.keys(files || {}).map(path => String(path || '').replace(/\\/g, '/')));
    return getRequiredProjectFiles(loader).filter(path => !normalized.has(path));
  }

  window.CodexBuildProject = {
    createGeneratedProject({ fullText, wrapperFiles }) {
      const files = withWrapperFiles(parseGeneratedFiles(fullText), wrapperFiles);
      return { files };
    },
    getMissingProjectFiles,
  };
})();
