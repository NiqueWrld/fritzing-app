/*******************************************************************

Part of the Fritzing project - http://fritzing.org

Fritzing is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

********************************************************************/

// Copilot tab: the AI chat view plus the actions it can run on the sketch.

#include "mainwindow.h"
#include "sketchareawidget.h"
#include "../copilot/copilotview.h"
#include "../commands.h"
#include "../waitpushundostack.h"
#include "../connectors/connectoritem.h"
#include "../items/itembase.h"
#include "../model/modelpart.h"
#include "../referencemodel/referencemodel.h"
#include "../sketch/breadboardsketchwidget.h"
#include "../sketch/pcbsketchwidget.h"
#include "../sketch/schematicsketchwidget.h"
#include "../sketch/sketchwidget.h"

#include <QGraphicsScene>
#include <QJsonArray>
#include <QSet>

namespace {

QJsonObject err(const QString & message) {
	return QJsonObject{ { "error", message } };
}

long jsonId(const QJsonValue & v) {
	if (v.isString()) return v.toString().toLong();
	return static_cast<long>(v.toDouble());
}

bool isPart(ItemBase * item) {
	if (item == nullptr || item->layerKinChief() != item) return false;
	int t = item->itemType();
	return t != ModelPart::Wire && t != ModelPart::Unknown;
}

QList<ItemBase *> sketchParts(SketchWidget * sketch) {
	QList<ItemBase *> parts;
	QSet<ItemBase *> seen;
	for (QGraphicsItem * gi : sketch->scene()->items()) {
		auto * item = dynamic_cast<ItemBase *>(gi);
		if (!isPart(item) || seen.contains(item)) continue;
		seen.insert(item);
		parts.append(item);
	}
	return parts;
}

QJsonArray connectorsJson(ItemBase * item) {
	QJsonArray arr;
	for (ConnectorItem * c : item->cachedConnectorItems()) {
		arr.append(QJsonObject{ { "id", c->connectorSharedID() }, { "name", c->connectorSharedName() } });
	}
	return arr;
}

QJsonObject partJson(ItemBase * item, bool withConnectors) {
	QJsonObject o{ { "id", QString::number(item->id()) },
	               { "title", item->title() },
	               { "label", item->instanceTitle() },
	               { "moduleID", item->moduleID() } };
	if (withConnectors) o["connectors"] = connectorsJson(item);
	return o;
}

ConnectorItem * findConnector(ItemBase * item, const QString & key) {
	for (ConnectorItem * c : item->cachedConnectorItems()) {
		if (c->connectorSharedID().compare(key, Qt::CaseInsensitive) == 0) return c;
	}
	for (ConnectorItem * c : item->cachedConnectorItems()) {
		if (c->connectorSharedName().compare(key, Qt::CaseInsensitive) == 0) return c;
	}
	return nullptr;
}

}

void MainWindow::initCopilotView() {
	auto * view = new CopilotView([this](const QJsonObject & action) { return copilotExecute(action); }, this);
	auto * sketchAreaWidget = new SketchAreaWidget(view, this, false, false);
	addTab(sketchAreaWidget, ":/resources/images/icons/TabWidgetCodeActive_icon.png", tr("Copilot"), true);
}

QJsonObject MainWindow::copilotExecute(const QJsonObject & action) {
	const QString name = action["action"].toString();
	SketchWidget * sketch = m_breadboardGraphicsView;
	if (sketch == nullptr) return err("sketch not ready");

	if (name == "search_parts") {
		QString query = action["query"].toString().trimmed();
		if (query.isEmpty()) return err("query is empty");
		QJsonArray arr;
		QSet<QString> seen;
		for (ModelPart * mp : m_referenceModel->search(query, false)) {
			if (mp == nullptr || seen.contains(mp->moduleID())) continue;
			seen.insert(mp->moduleID());
			arr.append(QJsonObject{ { "moduleID", mp->moduleID() }, { "title", mp->title() } });
			if (arr.count() >= 20) break;
		}
		return QJsonObject{ { "parts", arr } };
	}

	if (name == "add_part") {
		QString moduleID = action["moduleID"].toString();
		ModelPart * mp = m_referenceModel->retrieveModelPart(moduleID);
		if (mp == nullptr) return err("unknown moduleID; use search_parts first");

		QSet<long> before;
		for (ItemBase * item : sketchParts(sketch)) before.insert(item->id());

		QList<ModelPart *> list{ mp };
		sketch->addToSketch(list);

		for (ItemBase * item : sketchParts(sketch)) {
			if (!before.contains(item->id())) return QJsonObject{ { "added", partJson(item, true) } };
		}
		return err("part could not be added");
	}

	if (name == "list_parts") {
		QJsonArray arr;
		for (ItemBase * item : sketchParts(sketch)) arr.append(partJson(item, false));
		return QJsonObject{ { "parts", arr } };
	}

	if (name == "get_connectors") {
		ItemBase * item = sketch->findItem(jsonId(action["id"]));
		if (item == nullptr) return err("no part with that id");
		return partJson(item, true);
	}

	if (name == "connect") {
		ItemBase * from = sketch->findItem(jsonId(action["fromId"]));
		ItemBase * to = sketch->findItem(jsonId(action["toId"]));
		if (from == nullptr || to == nullptr) return err("fromId or toId not found");
		ConnectorItem * fc = findConnector(from, action["fromConnector"].toString());
		ConnectorItem * tc = findConnector(to, action["toConnector"].toString());
		if (fc == nullptr) return QJsonObject{ { "error", "fromConnector not found" }, { "available", connectorsJson(from) } };
		if (tc == nullptr) return QJsonObject{ { "error", "toConnector not found" }, { "available", connectorsJson(to) } };

		auto * parent = new QUndoCommand(tr("Copilot: connect %1 to %2").arg(from->instanceTitle(), to->instanceTitle()));
		long wireId = sketch->createWire(fc, tc, ViewGeometry::NoFlag, false, BaseCommand::CrossView, parent);
		sketch->undoStack()->push(parent);
		return QJsonObject{ { "wireId", QString::number(wireId) } };
	}

	if (name == "delete_part") {
		ItemBase * item = sketch->findItem(jsonId(action["id"]));
		if (item == nullptr) return err("no part with that id");
		sketch->selectItems({ item });
		sketch->deleteSelected(nullptr, false);
		return QJsonObject{ { "deleted", true } };
	}

	if (name == "switch_view") {
		QString view = action["view"].toString().toLower();
		if (view == "breadboard") showBreadboardView();
		else if (view == "schematic") showSchematicView();
		else if (view == "pcb") showPCBView();
		else return err("view must be breadboard, schematic or pcb");
		return QJsonObject{ { "view", view } };
	}

	if (name == "autoroute") {
		if (qobject_cast<SketchWidget *>(m_currentGraphicsView) == nullptr) showPCBView();
		newAutoroute();
		return QJsonObject{ { "autorouted", true } };
	}

	if (name == "undo") { if (m_undoAct) m_undoAct->trigger(); return QJsonObject{ { "ok", true } }; }
	if (name == "redo") { if (m_redoAct) m_redoAct->trigger(); return QJsonObject{ { "ok", true } }; }
	if (name == "save") { return QJsonObject{ { "saved", save() } }; }

	return err("unknown action: " + name);
}
