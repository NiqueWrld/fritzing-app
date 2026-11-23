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

#ifndef CLOUDPARTS_H
#define CLOUDPARTS_H

#include <QString>
#include <functional>

// The parts library is not shipped with the app. It is downloaded from the Fritzing
// Cloudflare Worker (bundle/fritzing-parts.zip) into app data on first launch, and
// replaced whenever bundle/version.txt (the fritzing-parts commit) changes.
class CloudParts
{
public:
	// status(message, progress 0..1 or -1 when unknown)
	using StatusCallback = std::function<void(const QString &, double)>;

	// Returns the local parts folder to use, or an empty string when no copy is
	// available (offline on first launch). Works offline once a copy is cached.
	static QString ensure(const StatusCallback & status);

	static QString localPath();
	static QString baseUrl();
};

#endif
