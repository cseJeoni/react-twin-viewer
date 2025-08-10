#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseWithCovarianceStamped
import requests
import threading
import time

SERVER = "http://192.168.219.149:8000"   # server.py가 뜬 곳
POST_URL = f"{SERVER}/pose"              # 그대로 /pose 로 보냄

class PoseSender(Node):
    def __init__(self):
        super().__init__('pose_sender_react')
        self.sub = self.create_subscription(
            PoseWithCovarianceStamped, '/amcl_pose', self.cb, 10)
        self.last = None
        self.lock = threading.Lock()

    def cb(self, msg):
        x = float(msg.pose.pose.position.x)
        y = float(msg.pose.pose.position.y)
        with self.lock:
            self.last = (x, y)

def main():
    rclpy.init()
    node = PoseSender()
    try:
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=0.1)
            with node.lock:
                pt = node.last
            if pt:
                x, y = pt
                try:
                    requests.post(POST_URL, json={"x": x, "y": y}, timeout=0.2)
                except Exception:
                    pass
            time.sleep(0.05)  # 약 20Hz
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
