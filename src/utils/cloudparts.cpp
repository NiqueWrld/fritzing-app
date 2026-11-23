/*******************************************************************

Part of the Fritzing project - http://fritzing.org
Copyright (c) 2007-2026 Fritzing GmbH

Fritzing is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Fritzing is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Fritzing.  If not, see <http://www.gnu.org/licenses/>.

********************************************************************/

#include "cloudparts.h"
#include "../debugdialog.h"

#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>

#include <quazip/JlCompress.h>

namespace {

const char * DefaultBaseUrl = "https://fritzing-storage.siyathokoza321.workers.dev/parts/file/bundle";
const QString ShaFileName = ".parts-sha";

QString readLocalSha(const QString & dir) {
	QFile file(dir + "/" + ShaFileName);
	if (!file.open(QIODevice::ReadOnly)) return QString();
	return QString::fromLatin1(file.readAll().trimmed());
}

bool isUsable(const QString & dir) {
	return QDir(dir + "/core").exists() && !readLocalSha(dir).isEmpty();
}

// Runs a GET to completion. Aborts if no data arrives for idleMs.
QNetworkReply * fetch(QNetworkAccessManager & manager, const QString & url, int idleMs,
                      const std::function<void(QNetworkReply *, qint64, qint64)> & progress = nullptr) {
	QNetworkRequest request{QUrl(url)};
	request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
	QNetworkReply * reply = manager.get(request);

	QEventLoop loop;
	QTimer idle;
	idle.setSingleShot(true);
	idle.setInterval(idleMs);
	QObject::connect(&idle, &QTimer::timeout, reply, &QNetworkReply::abort);
	QObject::connect(reply, &QNetworkReply::downloadProgress, &loop, [&](qint64 received, qint64 total) {
		idle.start();
		if (progress) progress(reply, received, total);
	});
	QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
	idle.start();
	loop.exec();
	return reply;
}

}

QString CloudParts::baseUrl() {
	QString url = qEnvironmentVariable("FRITZING_CLOUD_PARTS_URL");
	if (url.isEmpty()) url = QSettings().value("cloudPartsUrl").toString();
	if (url.isEmpty()) url = DefaultBaseUrl;
	while (url.endsWith('/')) url.chop(1);
	return url;
}

QString CloudParts::localPath() {
	return QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/fritzing-parts";
}

QString CloudParts::ensure(const StatusCallback & status) {
	const QString dir = localPath();
	const bool haveLocal = isUsable(dir);
	const QString localSha = haveLocal ? readLocalSha(dir) : QString();

	QNetworkAccessManager manager;
	status(QObject::tr("Checking for parts updates..."), -1);

	QNetworkReply * versionReply = fetch(manager, baseUrl() + "/version.txt", 10000);
	const QString remoteSha = versionReply->error() == QNetworkReply::NoError
	                          ? QString::fromLatin1(versionReply->readAll().trimmed()) : QString();
	if (remoteSha.isEmpty()) {
		DebugDialog::debug(QString("Cloud parts: version check failed (%1)").arg(versionReply->errorString()), DebugDialog::Warning);
	}
	versionReply->deleteLater();

	if (remoteSha.isEmpty() || remoteSha == localSha) {
		return haveLocal ? dir : QString();
	}

	DebugDialog::debug(QString("Cloud parts: downloading %1 (have %2)").arg(remoteSha, localSha.isEmpty() ? "none" : localSha), DebugDialog::Info);
	const QString cacheDir = QStandardPaths::writableLocation(QStandardPaths::CacheLocation);
	QDir().mkpath(cacheDir);
	const QString zipPath = cacheDir + "/fritzing-parts.zip";

	QFile zipFile(zipPath);
	if (!zipFile.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		DebugDialog::debug("Cloud parts: cannot write " + zipPath, DebugDialog::Error);
		return haveLocal ? dir : QString();
	}

	const QString downloading = haveLocal ? QObject::tr("Updating parts library...") : QObject::tr("Downloading parts library...");
	// Stream to disk as data arrives so the ~40 MB zip is never held in memory.
	QNetworkReply * zipReply = fetch(manager, baseUrl() + "/fritzing-parts.zip", 60000, [&](QNetworkReply * reply, qint64 received, qint64 total) {
		zipFile.write(reply->readAll());
		status(QString("%1 %2 MB").arg(downloading).arg(received / 1048576.0, 0, 'f', 1),
		       total > 0 ? double(received) / double(total) : -1);
	});
	// Write whatever arrived after the last progress signal.
	zipFile.write(zipReply->readAll());
	zipFile.close();
	const bool downloaded = zipReply->error() == QNetworkReply::NoError;
	if (!downloaded) {
		DebugDialog::debug("Cloud parts: download failed: " + zipReply->errorString(), DebugDialog::Error);
	}
	zipReply->deleteLater();
	if (!downloaded) {
		QFile::remove(zipPath);
		return haveLocal ? dir : QString();
	}

	status(QObject::tr("Unpacking parts library..."), -1);
	const QString staging = dir + ".new";
	QDir(staging).removeRecursively();
	QDir().mkpath(staging);
	const QStringList extracted = JlCompress::extractDir(zipPath, staging);
	QFile::remove(zipPath);
	if (extracted.isEmpty() || !isUsable(staging) || readLocalSha(staging) != remoteSha) {
		DebugDialog::debug("Cloud parts: downloaded bundle is incomplete", DebugDialog::Error);
		QDir(staging).removeRecursively();
		return haveLocal ? dir : QString();
	}

	// Swap in the new copy. The old parts.db goes with it, so the parts database is rebuilt.
	QDir(dir).removeRecursively();
	if (!QDir().rename(staging, dir)) {
		DebugDialog::debug("Cloud parts: could not move " + staging + " to " + dir, DebugDialog::Error);
		return isUsable(staging) ? staging : QString();
	}
	return dir;
}
