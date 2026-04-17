from app.agent.ns_pivot import match_pivot_target


def make_node(title, keywords):
    return {"id": "n1", "title": title, "description": "", "depth_level": 1, "keywords": keywords}


def test_exact_title_match():
    nodes = [make_node("gRPC", ["grpc", "rpc"]), make_node("HTTP", ["http"])]
    matched = match_pivot_target(nodes, target="gRPC")
    assert matched is not None
    assert matched["title"] == "gRPC"


def test_keyword_match_case_insensitive():
    nodes = [make_node("이벤트 루프", ["event loop", "이벤트", "루프"])]
    matched = match_pivot_target(nodes, target="event Loop")
    assert matched is not None


def test_no_match_returns_none():
    nodes = [make_node("HTTP", ["http"])]
    matched = match_pivot_target(nodes, target="요리")
    assert matched is None


def test_partial_title_match():
    nodes = [make_node("이벤트 루프", ["이벤트"])]
    matched = match_pivot_target(nodes, target="이벤트루프")
    assert matched is not None
