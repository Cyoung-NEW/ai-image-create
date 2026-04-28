import json
import time
import requests

# 复用查询脚本中的轮询函数
import importlib.util, pathlib
_spec = importlib.util.spec_from_file_location(
    "gpt_image_2_query",
    pathlib.Path(__file__).parent / "gpt-image-2-query.py",
)
_query_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_query_mod)
poll_task = _query_mod.poll_task

# 请替换成你在速创API官网获取的API Key
API_KEY = "6QqC2rPcRcyCYbt24TYRG5dvWg"
# 速创API的官方接口地址
BASE_URL = "https://api.wuyinkeji.com/api/async/image_gpt"

HEADERS = {
    "Authorization": API_KEY,
    "Content-Type": "application/json",
}

# 按照速创API文档的请求参数格式
PAYLOAD = {
    "prompt": "生成一张张学友在抖音带货的照片",
    "size": "1:1",
}


def submit_task() -> str | None:
    """提交异步图像生成任务，返回任务 ID（失败则返回 None）。"""
    try:
        print("正在向速创API发送请求，请稍候...")
        start_time = time.time()

        response = requests.post(
            f"{BASE_URL}?key={API_KEY}",
            headers=HEADERS,
            data=json.dumps(PAYLOAD),
            timeout=300,
        )
        elapsed_time = time.time() - start_time

        response.raise_for_status()
        result = response.json()

        print(f"请求完成！耗时: {elapsed_time:.2f} 秒")
        print("=" * 30)
        print(f"状态码 (code): {result.get('code')}")
        print(f"状态信息 (msg): {result.get('msg')}")
        print(f"执行耗时 (exec_time): {result.get('exec_time')}")
        print(f"客户端IP (user_ip): {result.get('user_ip')}")

        data = result.get("data")
        if data is not None:
            if isinstance(data, dict):
                task_id = data.get("id")
                print(f"任务ID (data.id): {task_id}")
                return task_id
            else:
                print(f"data 内容: {data}")
        else:
            print("警告: data 为 None，请检查参数或 API Key。")

        print("完整响应 JSON:")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return None

    except requests.exceptions.RequestException as e:
        print(f"请求失败: {e}")
        if hasattr(e, "response") and e.response is not None:
            print(f"响应状态码: {e.response.status_code}")
            print(f"响应内容: {e.response.text}")
        return None

    except ValueError as e:
        print(f"JSON 解析错误: {e}")
        return None


if __name__ == "__main__":
    tid = submit_task()
    if tid:
        print("=" * 30)
        poll_task(tid)
    else:
        print("未获取到任务 ID，跳过查询。")
